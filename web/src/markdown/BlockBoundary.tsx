import { Component, useEffect, useState, type ReactNode } from 'react';
import { Graph, GraphBody } from '@/registry/default/graph-frame/graph-frame';
import { nodeSource, type ElementNode } from '../../../shared/markdown.ts';

interface Props {
  node: ElementNode;
  /** The last block of a streaming message: its props may still be arriving. */
  open: boolean;
  render: (node: ElementNode) => ReactNode;
}

interface State {
  error: Error | null;
  node: ElementNode | null;
  /** The last node that rendered without throwing. */
  good: ElementNode | null;
}

/**
 * One per block. A figure that throws shows a fallback frame (tag name, the error in muted text, the
 * block's source collapsed) and the rest of the message renders normally. While the block is still
 * streaming, a throw (half-written rows, say) keeps the last good render, or an empty frame, instead.
 */
export class BlockBoundary extends Component<Props, State> {
  state: State = { error: null, node: null, good: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State) {
    // A new tree for this block gets a fresh try.
    return props.node !== state.node ? { error: null, node: props.node } : null;
  }

  componentDidMount() {
    this.remember();
  }

  componentDidUpdate() {
    this.remember();
  }

  private remember() {
    if (!this.state.error && this.state.good !== this.props.node) this.setState({ good: this.props.node });
  }

  render() {
    const { error, good } = this.state;
    const { node, open, render } = this.props;
    if (!error) return render(node);
    if (open) return good && good !== node ? render(good) : <PendingFrame node={node} />;
    return <BlockFallback node={node} error={error} />;
  }
}

function PendingFrame({ node }: { node: ElementNode }) {
  const title = typeof node[1]?.title === 'string' ? node[1].title : undefined;
  return (
    <Graph title={title} className="md-figure">
      <GraphBody className="flex items-center justify-center py-5">
        <span className="font-mono text-sm text-graph-frame select-none">· · ·</span>
      </GraphBody>
    </Graph>
  );
}

function BlockFallback({ node, error }: { node: ElementNode; error: Error }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    nodeSource(node).then(
      (s) => live && setSource(s.trim()),
      () => live && setSource(null),
    );
    return () => {
      live = false;
    };
  }, [node]);
  return (
    <Graph title={node[0]} className="md-unknown md-figure" data-error="">
      <GraphBody className="flex flex-col gap-3 py-6 text-xs">
        <p className="text-graph-muted">Could not render this figure: {error.message}</p>
        {source !== null && (
          <details>
            <summary className="cursor-pointer text-graph-muted select-none">source</summary>
            <pre className="graph-scroll-x mt-3 whitespace-pre text-graph-muted">{source}</pre>
          </details>
        )}
      </GraphBody>
    </Graph>
  );
}
