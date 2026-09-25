// Native element overrides for plain markdown (Phase 3 of the Comark plan).
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { Graph, GraphBody, GraphRule } from '@/registry/default/graph-frame/graph-frame';
import { cn } from '@/lib/utils';

type Align = 'left' | 'right' | 'center';
type Cell = { content: ReactNode; align?: Align };

const elements = (children: ReactNode): ReactElement<{ children?: ReactNode; align?: string }>[] =>
  Children.toArray(children).filter(isValidElement) as ReactElement<{ children?: ReactNode; align?: string }>[];

const rowsOf = (section?: ReactElement<{ children?: ReactNode }>): Cell[][] =>
  section
    ? elements(section.props.children)
        .filter((tr) => tr.type === 'tr')
        .map((tr) => elements(tr.props.children).map((c) => ({ content: c.props.children, align: c.props.align as Align | undefined })))
    : [];

const alignClass = (a: Align | undefined) => (a === 'right' ? 'text-right tabular-nums' : a === 'center' ? 'text-center' : 'text-left');

function RuleY() {
  return <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 graph-rule-y" />;
}

/**
 * A GFM table in the same frame and markup as `::graph-table`, so the two look alike. Cells keep their
 * inline markdown; GFM alignment is respected (left when unset); wide tables scroll inside the frame.
 */
export function MdTable({ children }: { children?: ReactNode }) {
  const parts = elements(children);
  const head = rowsOf(parts.find((p) => p.type === 'thead'))[0] ?? [];
  const body = rowsOf(parts.find((p) => p.type === 'tbody'));
  return (
    <Graph className="md-figure">
      <GraphBody className="px-3 py-6 sm:px-6 sm:py-8">
        <div className="graph-scroll-x">
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr>
                {head.map((h, i) => (
                  <th key={i} className={cn('relative px-3 pb-3 font-normal whitespace-nowrap text-foreground', alignClass(h.align))}>
                    {i > 0 ? <RuleY /> : null}
                    {h.content}
                  </th>
                ))}
              </tr>
              <tr>
                <th colSpan={Math.max(head.length, 1)} className="p-0">
                  <GraphRule />
                </th>
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} className={cn('relative min-w-[8ch] px-3 py-2.5 align-top', alignClass(head[i]?.align ?? c.align), head[i]?.align === 'right' && 'whitespace-nowrap')}>
                      {i > 0 ? <RuleY /> : null}
                      {c.content}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GraphBody>
    </Graph>
  );
}

/** Images: dashed frame, alt text as the frame title, never wider than the column; a faint inner outline gives pale images an edge. */
export function MdImage({ src, alt, title, framed }: { src?: string; alt?: string; title?: string; framed?: boolean }) {
  if (!src) return alt ? <span className="text-graph-muted">[{alt}]</span> : null;
  if (!framed) return <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" className="inline max-w-full align-middle" />;
  return (
    <Graph title={alt || undefined} className="md-figure">
      <GraphBody className="px-4 py-6 sm:px-6">
        <img src={src} alt={alt ?? ''} title={title} loading="lazy" referrerPolicy="no-referrer" className="mx-auto max-w-full outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />
      </GraphBody>
    </Graph>
  );
}

/** Task list checkbox as a `[x]` / `[ ]` glyph, matching graph-check. */
export function TaskMark({ checked }: { checked?: boolean }) {
  return (
    <span className="md-task" data-done={checked ? '' : undefined} role="img" aria-label={checked ? 'done' : 'not done'}>
      {checked ? '[x]' : '[ ]'}
    </span>
  );
}

/** The first non-blank text a node renders, however deeply it is wrapped (streaming wraps words in spans). */
function firstText(node: ReactNode): string {
  for (const child of Children.toArray(node)) {
    const text = typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? firstText(child.props.children) : '';
    if (text.trim()) return text.trimStart();
  }
  return '';
}

/** Blocks whose first line is not the quote's own first line (a list item, a heading, code). */
const OTHER_BLOCKS = new Set(['ul', 'ol', 'pre', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);

/**
 * A quote that opens with a quotation mark is marked `data-hang`, so the mark can hang into the margin
 * where `hanging-punctuation` is unsupported (markdown.css). Comark writes a one-paragraph quote's text
 * straight into the blockquote, a longer one as paragraphs.
 */
export function MdBlockquote({ children, ...rest }: ComponentProps<'blockquote'>) {
  const first = Children.toArray(children).find((c) => typeof c !== 'string' || c.trim());
  const opensWithMark = !(isValidElement(first) && typeof first.type === 'string' && OTHER_BLOCKS.has(first.type)) && /^[“"‘'«„‚‹]/.test(firstText(children));
  return (
    <blockquote {...rest} data-hang={opensWithMark ? '' : undefined}>
      {children}
    </blockquote>
  );
}
