import { MarkdownDocument } from '@comark/react';
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Block } from './blocks.ts';
import { components } from './components.tsx';
import { BlockBoundary } from './BlockBoundary.tsx';
import { BlockContext } from './context.ts';
import { cachedFinal, parseFinal, parseMessage, type Parsed } from './parse.ts';
import { streamWords, useStreamWords } from './stream-words.ts';
import { componentTags } from './tags.ts';

export interface MessageMarkdownProps {
  /** Message ID (cache key). */
  id: string;
  content: string;
  /** While streaming, parses are coalesced to one per animation frame and failures keep the last tree. */
  streaming?: boolean;
  /** Wraps each rendered block, e.g. with thread controls. Defaults to a plain div. */
  renderBlock?: (block: Block, content: ReactNode, isLast: boolean) => ReactNode;
  className?: string;
}

export function useParsed(id: string, content: string, streaming: boolean): Parsed | null {
  const [parsed, setParsed] = useState<Parsed | null>(() => (streaming ? null : (cachedFinal(id, content) ?? null)));
  const latest = useRef({ content, streaming });
  latest.current = { content, streaming };
  const frame = useRef<number | null>(null);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!streaming) {
      const hit = cachedFinal(id, content);
      if (hit) {
        setParsed(hit);
        return;
      }
      // Comark's parse resolves within microtasks, so flushing here renders before the browser paints.
      parseFinal(id, content).then((r) => {
        if (r && mounted.current && latest.current.content === content) flushSync(() => setParsed(r));
      });
      return;
    }
    if (frame.current !== null) return; // a parse is already scheduled for this frame
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const md = latest.current.content;
      parseMessage(md).then((r) => {
        // null: an unparseable prefix; the previous tree stays on screen.
        if (r && mounted.current && latest.current.streaming) setParsed((prev) => holdFigureProps(prev, r));
      });
    });
  }, [id, content, streaming]);

  return parsed;
}

/**
 * While streaming, a figure's YAML props can parse on one frame and not on the next (a prefix that
 * ends mid-key reads as a bare string). If the last block is the same component with less data than
 * before, keep the previous node so the figure does not flicker back to its empty frame.
 */
export function holdFigureProps(prev: Parsed | null, next: Parsed): Parsed {
  const a = prev?.blocks.at(-1);
  const b = next.blocks.at(-1);
  if (!a || !b || a.index !== b.index || a.node[0] !== b.node[0] || !componentTags.has(b.node[0])) return next;
  const size = (n: Block['node']) => JSON.stringify(n[1]).length;
  if (size(b.node) >= size(a.node)) return next;
  const blocks = [...next.blocks.slice(0, -1), a];
  const tree = next.tree.map((n) => (n === b.node ? a.node : n));
  return { tree, blocks };
}

/**
 * Every message body renders through this: the Comark tree, one `data-block` per top-level node.
 * Each block's content sits in its own `.md-root` (tokens + Tailwind scope), so chrome controls around a
 * block (thread gutter, reply badge) keep the chrome's variables.
 */
export const MessageMarkdown = memo(function MessageMarkdown({ id, content, streaming = false, renderBlock, className }: MessageMarkdownProps) {
  const parsed = useParsed(id, content, streaming);
  // A finished message whose markdown cannot be parsed at all: show the text as is.
  if (!parsed) return content && !streaming ? <div className={`md-body md-unparsed ${className ?? ''}`}>{content}</div> : null;
  return <MarkdownBlocks parsed={parsed} streaming={streaming} renderBlock={renderBlock} className={className} />;
});

/**
 * Renders an already parsed message: one `data-block` per top-level node, each with its own boundary.
 * `parsed.blocks` may be a slice of the message; `total` is then its full block count.
 */
export function MarkdownBlocks({
  parsed,
  streaming = false,
  renderBlock,
  className,
  total,
}: { parsed: Parsed; total?: number } & Pick<MessageMarkdownProps, 'streaming' | 'renderBlock' | 'className'>) {
  const n = total ?? parsed.blocks.length;
  const ref = useRef<HTMLDivElement>(null);
  useStreamWords(ref, streaming);
  return (
    <div ref={ref} className={`md-body ${streaming ? 'md-streaming' : ''} ${className ?? ''}`}>
      {parsed.blocks.map((b) => {
        const last = b.index === n - 1;
        // The block before the one being written keeps its word spans, so its last words finish fading in.
        const body = <BlockView node={b.node} last={last} open={streaming && last} words={streaming && b.index >= n - 2} />;
        return renderBlock ? (
          <Fragment key={b.index}>{renderBlock(b, body, last)}</Fragment>
        ) : (
          <div key={b.index} data-block={b.index}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

const renderNode = (node: Block['node']) => <MarkdownDocument value={{ nodes: [node] }} components={components} />;

const OPEN = { open: true };
const CLOSED = { open: false };

const BlockView = memo(function BlockView({ node: source, last, open, words }: { node: Block['node']; last: boolean; open: boolean; words: boolean }) {
  // The block still being written streams its words in; a finished block renders as written.
  const node = useMemo(() => (words ? streamWords(source) : source), [source, words]);
  return (
    <BlockContext.Provider value={open ? OPEN : CLOSED}>
      <div className={`md-root ${last ? 'md-last' : ''}`}>
        <BlockBoundary node={node} open={open} render={renderNode} />
      </div>
    </BlockContext.Provider>
  );
});
