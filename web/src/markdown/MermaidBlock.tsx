// ```mermaid fences as diagrams. A lazy chunk (React.lazy from CodeBlock); `mermaid` itself is imported
// on first use and initialised once. The only HTML that reaches the page is Mermaid's own SVG, rendered
// with securityLevel "strict" (no click handlers, no HTML labels).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Graph, GraphBody } from '@/registry/default/graph-frame/graph-frame';
import { hash } from './cache.ts';

type Mermaid = (typeof import('mermaid'))['default'];

let mermaidLoad: Promise<Mermaid> | null = null;
let seq = 0;
const svgCache = new Map<string, { svg: string } | { error: string }>();

const BASE = {
  startOnLoad: false,
  securityLevel: 'strict' as const,
  htmlLabels: false,
  suppressErrorRendering: true,
  // Mermaid's default wrap width is for proportional type; in Hack it split words like "reins/tall" mid-word.
  flowchart: { wrappingWidth: 200 },
  // Keys a diagram's own directives may never change.
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'darkMode'],
};

const loadMermaid = () => (mermaidLoad ??= import('mermaid').then((m) => m.default));

// Renders one diagram at a time: each render re-initialises Mermaid with the theme of its own frame.
let queue: Promise<unknown> = Promise.resolve();
function renderSvg(body: string, theme: ReturnType<typeof themeFrom>): Promise<{ svg: string } | { error: string }> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({ ...BASE, ...theme });
    try {
      await mermaid.parse(body);
      const { svg } = await mermaid.render(`md-mermaid-${++seq}`, body);
      return { svg };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e).split('\n').find((l) => l.trim()) ?? 'Invalid diagram' };
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Only the diagram itself reaches Mermaid: `%%{init: …}%%` directives and front-matter `config:` are
 * removed, so content cannot inject theme CSS or change the security level.
 */
export function stripDirectives(source: string): string {
  return source.replace(/%%\{[\s\S]*?\}%%/g, '').replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// Theme: re-render when <html> gains or loses .dark.
const subscribeDark = (fn: () => void) => {
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
};
const isDark = () => document.documentElement.classList.contains('dark');

/** Mermaid's colour code (khroma) cannot read oklch(); resolve a CSS colour to #rrggbb through a canvas. */
function hex(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const to = (v: number) => v.toString(16).padStart(2, '0');
  return a < 255 ? `#${to(r)}${to(g)}${to(b)}${to(a)}` : `#${to(r)}${to(g)}${to(b)}`;
}

/** Theme variables read from the markdown tokens where the diagram sits. */
function themeFrom(el: Element) {
  const cs = getComputedStyle(el);
  const v = (name: string) => hex(cs.getPropertyValue(name).trim() || '#888');
  const ink = v('--foreground');
  const bg = v('--background');
  const muted = v('--graph-muted');
  const accent = v('--graph-accent');
  const font = `'Hack', ui-monospace, monospace`;
  return {
    theme: 'base' as const,
    fontFamily: font,
    themeVariables: {
      darkMode: isDark(),
      dropShadow: 'none',
      background: 'transparent',
      fontFamily: font,
      fontSize: '13px',
      primaryColor: bg,
      primaryTextColor: ink,
      primaryBorderColor: ink,
      secondaryColor: bg,
      tertiaryColor: bg,
      mainBkg: bg,
      nodeBorder: ink,
      nodeTextColor: ink,
      textColor: ink,
      titleColor: ink,
      lineColor: muted,
      edgeLabelBackground: bg,
      clusterBkg: bg,
      clusterBorder: muted,
      actorBkg: bg,
      actorBorder: ink,
      actorTextColor: ink,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: ink,
      labelBoxBkgColor: bg,
      labelBoxBorderColor: muted,
      labelTextColor: ink,
      loopTextColor: ink,
      noteBkgColor: bg,
      noteBorderColor: muted,
      noteTextColor: ink,
      activationBkgColor: bg,
      activationBorderColor: ink,
      stateBkg: bg,
      stateLabelColor: ink,
      transitionColor: muted,
      transitionLabelColor: ink,
      specialStateColor: ink,
      attributeBackgroundColorOdd: bg,
      attributeBackgroundColorEven: bg,
      pie1: accent,
    },
    sequence: { actorFontSize: 13, messageFontSize: 13, noteFontSize: 13, actorFontFamily: font, messageFontFamily: font, noteFontFamily: font },
    // Dashed edges like the frames (2 px on, 5 px off).
    themeCSS: `
      .edgePath .path, .flowchart-link, path.relation, .relationshipLine, .messageLine0, .messageLine1,
      .transition, line.actor-line, .er.relationshipLine { stroke-dasharray: 2 5 !important; }
      .edgeLabel, .edgeLabel p, .labelBkg { background-color: ${bg} !important; }
      text, .nodeLabel, .edgeLabel, .messageText, .loopText, .noteText, .actor { font-family: ${font} !important; }
    `,
  };
}

/** Mermaid's `title:` front matter becomes the frame title; the rest of the source goes to Mermaid. */
export function splitTitle(source: string): { title: string | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!m) return { title: null, body: source };
  const t = /^title:\s*(.+)$/m.exec(m[1]);
  if (!t) return { title: null, body: source };
  const rest = m[1].replace(/^title:.*$\n?/m, '').trim();
  const title = t[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  return { title, body: (rest ? `---\n${rest}\n---\n` : '') + source.slice(m[0].length) };
}

export default function MermaidBlock({ code, open }: { code: string; open: boolean }) {
  const dark = useSyncExternalStore(subscribeDark, isDark, () => false);
  const { title, body } = useMemo(() => splitTitle(code), [code]);
  const key = `${hash(body)}:${dark ? 'dark' : 'light'}`;
  const [result, setResult] = useState(() => svgCache.get(key) ?? null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (open || !host) return;
    const hit = svgCache.get(key);
    if (hit) {
      setResult(hit);
      return;
    }
    let live = true;
    renderSvg(stripDirectives(body), themeFrom(host)).then((out) => {
      svgCache.set(key, out);
      if (live) setResult(out);
    });
    return () => {
      live = false;
    };
  }, [key, body, open, host]);

  const svg = !open && result && 'svg' in result ? result.svg : null;
  const error = !open && result && 'error' in result ? result.error : null;

  return (
    <Graph title={title ?? 'diagram'} className="md-mermaid md-figure" ref={setHost as never} data-state={open ? 'open' : svg ? 'ready' : error ? 'error' : 'loading'}>
      {svg ? (
        <>
          <button
            type="button"
            className="absolute top-0 right-4 z-10 -translate-y-1/2 bg-background px-2 font-mono text-xs tracking-wide text-graph-muted uppercase hover:text-graph-accent"
            onClick={() => setExpanded(true)}
            title="Show full width"
          >
            expand
          </button>
          <GraphBody className="md-mermaid-body graph-scroll-x max-h-[32rem] overflow-y-auto">
            <div className="md-mermaid-svg flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
          </GraphBody>
          {expanded && <Overlay svg={svg} title={title} onClose={() => setExpanded(false)} />}
        </>
      ) : (
        <GraphBody className="flex flex-col gap-3 py-6">
          {error && <p className="font-mono text-xs text-graph-muted">Could not draw this diagram: {error}</p>}
          <pre className="graph-scroll-x text-xs leading-relaxed whitespace-pre text-foreground">
            <code>{code}</code>
          </pre>
        </GraphBody>
      )}
    </Graph>
  );
}

function Overlay({ svg, title, onClose }: { svg: string; title: string | null; onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return createPortal(
    <div className="md-root md-mermaid-overlay fixed inset-0 z-50 flex flex-col bg-background p-8" role="dialog" aria-label={title ?? 'Diagram'} onClick={onClose}>
      <div className="mb-4 flex items-center justify-between font-mono text-xs tracking-wide uppercase">
        <span className="text-graph-accent">[ {title ?? 'diagram'} ]</span>
        <button type="button" className="text-graph-muted hover:text-graph-accent" onClick={onClose}>
          close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="md-mermaid-svg md-mermaid-full" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>,
    document.body,
  );
}
