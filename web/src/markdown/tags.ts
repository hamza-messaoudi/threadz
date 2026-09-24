// Tags the component map can render besides native markdown. Kept apart from components.tsx so the
// parser and sanitiser do not import React components. adapters.ts is data only.
import { GRAPH_ADAPTERS } from '@/registry/default/graph-comark/adapters';

export const graphTags: string[] = Object.keys(GRAPH_ADAPTERS);

export const componentTags: ReadonlySet<string> = new Set(graphTags);
