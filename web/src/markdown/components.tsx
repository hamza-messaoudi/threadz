import type { ComponentType, ReactNode } from 'react';
import { Graph, GraphBody } from '@/registry/default/graph-frame/graph-frame';
import { MdImage, MdTable, TaskMark } from './prose.tsx';
import { UNKNOWN_TAG } from './sanitize.ts';

/** Neutral frame for a tag that is not in the map: its name and the block's source. */
export function UnknownTag({ tag, source, inline }: { tag: string; source: string; inline?: boolean }) {
  if (inline) return <code className="md-unknown-inline" title={`<${tag}> is not available here`}>{source}</code>;
  return (
    <Graph title={tag} className="md-unknown" data-tag={tag}>
      <GraphBody className="py-6">
        <pre className="graph-scroll-x text-xs whitespace-pre text-graph-muted">{source}</pre>
      </GraphBody>
    </Graph>
  );
}

function Pre({ children, language }: { children?: ReactNode; language?: string }) {
  return (
    <pre data-language={language}>
      {children}
    </pre>
  );
}

/** The one tag → component map. Native overrides and figures are added by the later phases. */
export const components: Record<string, ComponentType<any>> = {
  [UNKNOWN_TAG]: UnknownTag,
  pre: Pre,
  table: MdTable,
  img: MdImage,
  input: TaskMark,
};
