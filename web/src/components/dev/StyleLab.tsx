import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../lib/useTheme.ts';
import { MessageMarkdown } from '../../markdown/MessageMarkdown.tsx';

// Fixture files, loaded on demand (this whole page is a lazy chunk).
const files = import.meta.glob('../../../../test/fixtures/markdown/*.md', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const names = Object.keys(files)
  .map((f) => f.split('/').pop()!.replace(/\.md$/, ''))
  .sort((a, b) => (a === 'prose' ? -1 : b === 'prose' ? 1 : a.localeCompare(b)));

// demo: the demo page's content width, on the demo's page colour, for comparisons with its screenshots.
const WIDTHS = { message: 720, thread: 360, demo: 832 } as const;
type Width = keyof typeof WIDTHS;

const param = (k: string) => new URLSearchParams(location.search).get(k);

/**
 * Style lab: renders fixtures through MessageMarkdown, in light or dark, at the message column or thread
 * panel width. Visual checks compare this page with the demo's reference screenshots.
 */
export default function StyleLab() {
  const [name, setName] = useState(param('fixture') ?? 'prose');
  const [width, setWidth] = useState<Width>((param('width') as Width) ?? 'message');
  const [theme, setTheme] = useTheme();
  const [source, setSource] = useState<string | null>(null);
  const [stream, setStream] = useState<{ at: number; speed: number } | null>(null);

  useEffect(() => {
    const load = Object.entries(files).find(([f]) => f.endsWith(`/${name}.md`))?.[1];
    setSource(null);
    setStream(null);
    // The demo's fixtures start with YAML frontmatter, which messages never have (and the parser leaves on).
    load?.().then((md) => setSource(md.replace(/^---\n[\s\S]*?\n---\n+/, '')));
  }, [name]);

  // Streaming mode: reveal the fixture a few characters per frame, as a model would.
  useEffect(() => {
    if (!stream || !source || stream.at >= source.length) return;
    const t = setTimeout(() => setStream((s) => s && { ...s, at: Math.min(source.length, s.at + s.speed) }), 16);
    return () => clearTimeout(t);
  }, [stream, source]);

  const shown = useMemo(() => (source && stream ? source.slice(0, stream.at) : source), [source, stream]);
  const streaming = !!stream && !!source && stream.at < source.length;

  const tab = (active: boolean) => `font-mono text-xs tracking-wide uppercase ${active ? 'text-graph-accent' : 'text-graph-muted hover:text-foreground'}`;
  const label = (active: boolean, text: string) => (active ? `[ ${text} ]` : text);

  return (
    <div className="style-lab" data-testid="style-lab">
      <div className="md-root style-lab-bar flex flex-wrap items-center gap-x-5 gap-y-2">
        {names.map((n) => (
          <button key={n} className={tab(n === name)} onClick={() => setName(n)}>
            {label(n === name, n)}
          </button>
        ))}
        <span className="text-graph-frame">|</span>
        {(Object.keys(WIDTHS) as Width[]).map((w) => (
          <button key={w} className={tab(w === width)} onClick={() => setWidth(w)}>
            {label(w === width, `${w} ${WIDTHS[w]}`)}
          </button>
        ))}
        <span className="text-graph-frame">|</span>
        {(['light', 'dark', 'system'] as const).map((t) => (
          <button key={t} className={tab(t === theme)} onClick={() => setTheme(t)}>
            {label(t === theme, t)}
          </button>
        ))}
        <span className="text-graph-frame">|</span>
        <button className={tab(!!stream)} onClick={() => setStream({ at: 0, speed: Number(param('speed') ?? 6) })}>
          {label(!!stream, 'stream')}
        </button>
      </div>
      <div className={`style-lab-canvas ${width === 'demo' ? 'lab-demo-surface' : ''}`} style={{ width: WIDTHS[width] }} data-testid="lab-canvas">
        {shown !== null && <MessageMarkdown key={`${name}:${stream ? 's' : 'f'}`} id={`lab:${name}`} content={shown} streaming={streaming} />}
      </div>
    </div>
  );
}
