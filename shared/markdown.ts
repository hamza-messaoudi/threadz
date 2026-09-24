// Comark parsing shared by the server (thread block_text) and the web renderer, so both split a
// message into the same top-level blocks.
import { createMarkdownParser, type MarkdownDocument, type Node } from 'comark';
import attributes from 'comark/plugins/attributes';
import components from 'comark/plugins/components';
import taskList from 'comark/plugins/task-list';
import { renderMarkdown } from 'comark/render';

export type { MarkdownDocument, Node };
export type ElementNode = [string, Record<string, unknown>, ...Node[]];

/**
 * No default plugins: that leaves out `html` (raw HTML stays literal text), `frontmatter`
 * (a message starting with `---` is a rule, as in CommonMark) and `alert`.
 */
export const parseComark = createMarkdownParser({
  registerDefaultPlugins: false,
  headingIds: false, // ids depend on the whole document, and content must not set DOM ids anyway
  plugins: [taskList(), components(), attributes(), blockLines()],
});

/** Records the source line range [start, end) of every top-level block in `meta.blockLines`. */
function blockLines() {
  return {
    name: 'agent-chat-block-lines',
    post(state: { tree: MarkdownDocument; tokens: unknown[] }) {
      const lines: [number, number, boolean][] = [];
      for (const t of state.tokens as { level: number; nesting: number; map: [number, number] | null; type: string }[]) {
        if (t.level === 0 && t.nesting !== -1 && t.map) lines.push([t.map[0], t.map[1], t.type === 'mdc_block_open']);
      }
      state.tree.meta.blockLines = lines;
    },
  };
}

export const isElement = (n: Node | undefined): n is ElementNode => Array.isArray(n) && typeof n[0] === 'string';

/** The top-level nodes that become blocks: elements only (whitespace text and comments are skipped). */
export function topLevelBlocks(doc: Pick<MarkdownDocument, 'nodes'>): ElementNode[] {
  return doc.nodes.filter(isElement);
}

/** One node back to Comark markdown; component props use a `---` YAML fence. */
export function nodeSource(node: Node): Promise<string> {
  return renderMarkdown({ nodes: [node] }, { blockAttributesStyle: 'frontmatter' });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Source of each top-level block, as the author wrote it: the block's own lines, checked by parsing
 * them again. Falls back to serialising the node (Comark's serialiser is lossy in a few cases, such as
 * a task item with a nested list). Throws if the markdown cannot be parsed.
 */
export async function blocksOf(source: string): Promise<string[]> {
  const doc = await parseComark(source);
  const nodes = topLevelBlocks(doc);
  const ranges = (doc.meta.blockLines ?? []) as [number, number, boolean][];
  const lines = source.split('\n');
  return Promise.all(
    nodes.map(async (node, i) => {
      const r = ranges.length === nodes.length ? ranges[i] : undefined;
      if (r) {
        let end = r[1];
        // A component's range stops before its closing `::` line.
        if (r[2] && end < lines.length && /^\s*:{2,}\s*$/.test(lines[end])) end++;
        const slice = lines.slice(r[0], end).join('\n').trim();
        const again = topLevelBlocks(await parseComark(slice));
        if (again.length === 1 && same(again[0], node)) return slice;
      }
      return (await nodeSource(node)).trim();
    }),
  );
}
