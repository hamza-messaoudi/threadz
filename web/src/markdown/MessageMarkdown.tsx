import { MarkdownDocument } from '@comark/react';
import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Block } from './blocks.ts';
import { components } from './components.tsx';
import { BlockContext } from './context.ts';
import { cachedFinal, parseFinal, parseMessage, type Parsed } from './parse.ts';

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
        if (r && mounted.current && latest.current.streaming) setParsed(r);
      });
    });
  }, [id, content, streaming]);

  return parsed;
}

/**
 * Every message body renders through this: the Comark tree, one `data-block` per top-level node.
 * Each block's content sits in its own `.md-root` (tokens + Tailwind scope), so chrome controls around a
 * block (thread gutter, reply badge) keep the chrome's variables.
 */
export const MessageMarkdown = memo(function MessageMarkdown({ id, content, streaming = false, renderBlock, className }: MessageMarkdownProps) {
  const parsed = useParsed(id, content, streaming);
  const cls = `md-body ${streaming ? 'md-streaming' : ''} ${className ?? ''}`;
  // A finished message whose markdown cannot be parsed at all: show the text as is.
  if (!parsed) return content && !streaming ? <div className={`${cls} md-unparsed`}>{content}</div> : null;
  const n = parsed.blocks.length;
  return (
    <div className={cls}>
      {parsed.blocks.map((b) => {
        const last = b.index === n - 1;
        const body = <BlockView node={b.node} last={last} open={streaming && last} />;
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
});

const OPEN = { open: true };
const CLOSED = { open: false };

const BlockView = memo(function BlockView({ node, last, open }: { node: Block['node']; last: boolean; open: boolean }) {
  return (
    <BlockContext.Provider value={open ? OPEN : CLOSED}>
      <div className={`md-root ${last ? 'md-last' : ''}`}>
        <MarkdownDocument value={{ nodes: [node] }} components={components} />
      </div>
    </BlockContext.Provider>
  );
});
