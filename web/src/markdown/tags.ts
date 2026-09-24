// Tags the component map can render (besides native markdown). Filled by later phases; kept apart from
// components.tsx so the parser does not import React components.
export const graphTags: string[] = [];

export const componentTags: ReadonlySet<string> = new Set(graphTags);
