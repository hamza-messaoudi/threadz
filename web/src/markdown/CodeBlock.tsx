import { Children, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { GraphCorners } from '@/registry/default/graph-frame/graph-frame';
import { BlockContext } from './context.ts';

// Highlighted HTML per (language, code), so re-mounts and re-renders never highlight twice.
const htmlCache = new Map<string, string | null>();
let shiki: Promise<typeof import('./shiki.ts')> | null = null;

/** Visible text of the <code> child that Comark renders inside <pre>. */
export function codeText(children: ReactNode): string {
  let out = '';
  Children.forEach(children, (c) => {
    if (typeof c === 'string' || typeof c === 'number') out += c;
    else if (isValidElement<{ children?: ReactNode }>(c)) out += codeText(c.props.children);
  });
  return out;
}

const LABELS: Record<string, string> = { ts: 'TS', typescript: 'TS', js: 'JS', javascript: 'JS', sh: 'SH', bash: 'BASH', shell: 'SH' };
export const languageLabel = (lang: string) => LABELS[lang] ?? lang.toUpperCase();

/**
 * Fenced code: plain monospaced text first, then Shiki's highlighting once the grammar is loaded.
 * While a message streams, the last block's fence may still be open, so it stays plain until the
 * message moves on or finishes.
 */
export function CodeBlock({ children, language }: { children?: ReactNode; language?: string }) {
  const code = codeText(children).replace(/\n$/, '');
  const lang = (language ?? '').trim().toLowerCase();
  const { open } = useContext(BlockContext);
  const key = `${lang}\u0000${code}`;
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(key) ?? null);

  useEffect(() => {
    if (!lang || open) return;
    if (htmlCache.has(key)) {
      setHtml(htmlCache.get(key)!);
      return;
    }
    let live = true;
    (shiki ??= import('./shiki.ts'))
      .then((m) => m.highlight(code, lang))
      .then(
        (h) => {
          htmlCache.set(key, h);
          if (live) setHtml(h);
        },
        () => htmlCache.set(key, null),
      );
    return () => {
      live = false;
    };
  }, [key, lang, code, open]);

  return (
    <figure className="md-code md-figure relative graph-frame font-mono text-foreground" data-language={lang || undefined}>
      {lang ? (
        <figcaption className="absolute top-0 left-4 z-10 -translate-y-1/2 bg-background px-2 text-xs tracking-wide uppercase">
          <span className="text-graph-accent">[ {languageLabel(lang)} ]</span>
        </figcaption>
      ) : null}
      <GraphCorners />
      <CopyButton code={code} />
      <pre className="graph-scroll-x px-5 pt-6 pb-5 text-xs leading-relaxed">
        {html !== null && !open ? <code className="md-shiki" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </figure>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="absolute top-0 right-4 z-10 -translate-y-1/2 bg-background px-2 font-mono text-xs tracking-wide text-graph-muted uppercase hover:text-graph-accent"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard blocked (insecure context): nothing to do.
        }
      }}
      title="Copy code"
    >
      {copied ? '[ copied ]' : 'copy'}
    </button>
  );
}
