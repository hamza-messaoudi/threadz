// Graph figures: mdxcn's Comark adapter plus the app's own container-query row.
import type { ReactNode } from 'react';
import { GRAPH_ADAPTERS } from '@/registry/default/graph-comark/adapters';
import { fromMarkdown } from '@/registry/default/graph-comark/from-markdown';
import { graphComponents } from '@/registry/default/graph-comark/graph-comark';
import { cn } from '@/lib/utils';

/**
 * `::row{cols=2}`: figures side by side. Collapses to one column when the message column is narrower
 * than 560 px (the 420 px thread panel), using the column's container query rather than the viewport.
 */
function Row({ cols = 2, className, children }: { cols?: number; className?: string; children?: ReactNode }) {
  const n = Math.min(Math.max(Math.round(Number(cols) || 2), 1), 3);
  return (
    <div className={cn('md-figure grid grid-cols-1 gap-6', n === 2 && '@min-[560px]:grid-cols-2', n === 3 && '@min-[560px]:grid-cols-2 @min-[840px]:grid-cols-3', className)}>
      {children}
    </div>
  );
}

export const figureComponents = {
  ...graphComponents,
  row: fromMarkdown(Row, GRAPH_ADAPTERS.row),
};
