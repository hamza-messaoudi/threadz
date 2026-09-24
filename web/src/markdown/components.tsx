import type { ComponentType, ReactNode } from 'react';
import { UNKNOWN_TAG } from './sanitize.ts';

/** Neutral frame for a tag that is not in the map: its name and the block's source. */
export function UnknownTag({ tag, source, inline }: { tag: string; source: string; inline?: boolean }) {
  if (inline) return <code className="md-unknown-inline" title={`<${tag}> is not available here`}>{source}</code>;
  return (
    <figure className="md-unknown relative graph-frame my-6 font-mono text-xs" data-tag={tag}>
      <figcaption className="absolute top-0 left-4 -translate-y-1/2 bg-background px-2 tracking-wide text-graph-muted uppercase">[ {tag} ]</figcaption>
      <pre className="graph-scroll-x px-5 pt-6 pb-5 whitespace-pre text-graph-muted">{source}</pre>
    </figure>
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
};
