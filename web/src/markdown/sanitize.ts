// Tree pass run on every parsed message before render. Agent output is untrusted (it can carry text
// from web pages and PR comments), so only known tags and attributes survive.
import { isElement, nodeSource, type ElementNode, type Node } from '../../../shared/markdown.ts';

/** Native markdown output. Anything else must be a registered component or it becomes a fallback. */
const NATIVE: Record<string, readonly string[]> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  a: ['href', 'title'],
  strong: [],
  em: [],
  del: [],
  s: [],
  code: [],
  pre: ['language', 'filename', 'meta'],
  blockquote: [],
  ul: [],
  ol: ['start'],
  li: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['align'],
  td: ['align'],
  hr: [],
  br: [],
  img: ['src', 'alt', 'title'],
  span: [],
  sup: [],
  sub: [],
  input: ['type', 'checked'],
};

/** Tag of the neutral frame that replaces an unknown component; props: `tag`, `source`, `inline`. */
export const UNKNOWN_TAG = 'md-unknown';

/** `{.class}` tokens content may keep: widths only, so nothing can position itself over the UI. */
const CLASS_OK = /^(max-w-(xs|sm|md|lg|xl|[2-7]xl|prose|none|full|\[\d{2,4}px\]|\[\d{1,3}ch\])|w-full)$/;

const SAFE_URL = /^(https?:|mailto:)/i;

/** http(s), mailto and relative URLs only. */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const u = url.trim();
  // Browsers ignore tabs and newlines inside a scheme ("java\nscript:"), so test the stripped form.
  const bare = u.replace(/[\u0000- \u007f]/g, '');
  if (SAFE_URL.test(bare)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//') || bare.startsWith('\\')) return undefined;
  return u;
}

function keepClasses(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const kept = value.split(/\s+/).filter((c) => CLASS_OK.test(c));
  return kept.length ? kept.join(' ') : undefined;
}

/** Attributes every node loses: event handlers, inline style, component redirection, Comark meta, numeric junk. */
function dropped(key: string): boolean {
  const k = key.replace(/^:/, '');
  return (
    k.startsWith('$') ||
    /^on/i.test(k) ||
    k === 'style' ||
    k === 'as' ||
    k === 'id' ||
    k === 'is' ||
    k === 'slot' ||
    k === 'dangerouslySetInnerHTML' ||
    k === 'ref' ||
    k === 'key' ||
    /^\d+$/.test(k) || // a half-streamed YAML scalar spread into props ({"0":"t","1":"i",…})
    k.startsWith('#')
  );
}

function nativeAttrs(tag: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = NATIVE[tag];
  if ((tag === 'th' || tag === 'td') && typeof attrs.style === 'string') {
    const m = /text-align:\s*(left|right|center)/.exec(attrs.style);
    if (m) out.align = m[1];
  }
  if (tag === 'input') {
    out.type = 'checkbox';
    const c = attrs[':checked'] ?? attrs.checked;
    out.checked = c === true || c === 'true' || c === '';
    return out;
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (dropped(k)) continue;
    if (k === 'class' || k === 'className') {
      const c = keepClasses(v);
      if (c) out.class = c;
    } else if (allowed.includes(k)) {
      if (k === 'href' || k === 'src') {
        const u = safeUrl(v);
        if (u) out[k] = u;
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
  }
  if (tag === 'a' && out.href) {
    out.target = '_blank';
    out.rel = 'noopener noreferrer';
  }
  return out;
}

function componentAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (dropped(k)) continue;
    if (k === 'class' || k === 'className' || k === ':class') {
      const c = keepClasses(v);
      if (c) out.class = c;
    } else out[k] = v;
  }
  return out;
}

/**
 * Returns a sanitised copy of `nodes`. The number of top-level nodes never changes, so block indices
 * match the raw tree (and the server's split).
 */
export async function sanitizeNodes(nodes: Node[], components: ReadonlySet<string>): Promise<Node[]> {
  const walk = async (node: Node, depth: number, parentTag: string | null): Promise<Node | null> => {
    if (typeof node === 'string') return node;
    if (!isElement(node)) return null; // comments
    const [tag, attrs = {}, ...children] = node as ElementNode;
    const nativeOk = tag in NATIVE && !(tag === 'input' && attrs.type !== 'checkbox');
    if (!nativeOk && !components.has(tag)) {
      const inline = depth > 0 && parentTag !== 'row';
      return [UNKNOWN_TAG, { tag, source: (await nodeSource(node)).trim(), inline }];
    }
    const kids: Node[] = [];
    for (const c of children) {
      const k = await walk(c, depth + 1, tag);
      if (k !== null) kids.push(k);
    }
    return [tag, nativeOk ? nativeAttrs(tag, attrs) : componentAttrs(attrs), ...kids];
  };
  const out: Node[] = [];
  for (const n of nodes) {
    const s = await walk(n, 0, null);
    // Keep the slot even for a dropped comment so indices stay aligned with the raw tree.
    out.push(s ?? '');
  }
  return out;
}
