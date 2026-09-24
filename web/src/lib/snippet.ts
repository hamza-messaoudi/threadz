// Search snippets come from FTS over the raw markdown, so a hit inside a figure's props shows YAML and
// `::` markers. This turns them back into readable text; <mark> highlights are kept.

const OPEN = '\u0001';
const CLOSE = '\u0002';
const unescape = (s: string) => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[e as 'lt']!);
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const plain = (s: string) => s.replace(/[\u0001\u0002]/g, '');

interface State {
  figure: string | null;
  /** Index in the output of the current figure's label, so a later `title:` line can fill it in. */
  label: number;
  props: boolean;
  mermaid: boolean;
  fence: boolean;
}

/** YAML values without their punctuation: `- ["/docs", "121 kB"]` → `/docs, 121 kB`. */
const data = (line: string) =>
  line
    .replace(/^(\s*…)?\s*-\s*/, '$1')
    .replace(/[[\]{}"]/g, '')
    .replace(/\s*,\s*/g, ', ')
    .trim();

/**
 * The FTS window often starts in the middle of a props block: then the first `---` comes before any
 * `::tag` line and is followed by the closing `::`.
 */
function startsInProps(lines: string[]): boolean {
  const bare = lines.map((l) => plain(l).trim());
  const fence = bare.indexOf('---');
  if (fence < 0 || bare.slice(0, fence).some((l) => /^:{2,}[a-z]/i.test(l))) return false;
  const next = bare.slice(fence + 1).find((l) => l);
  return next === undefined || /^:{2,}$/.test(next);
}

function cleanLines(lines: string[]): string[] {
  const st: State = { figure: null, label: -1, props: startsInProps(lines), mermaid: false, fence: false };
  const out: string[] = [];
  for (const line of lines) {
    const bare = plain(line).trim();
    if (st.mermaid || st.fence) {
      if (/^(`{3,}|~{3,})\s*$/.test(bare)) st.mermaid = st.fence = false;
      else if (st.fence) out.push(line);
      continue;
    }
    const fence = /^(`{3,}|~{3,})\s*([\w-]*)/.exec(bare);
    if (fence) {
      if (fence[2] === 'mermaid') {
        st.mermaid = true;
        out.push('[diagram]');
      } else st.fence = true;
      continue;
    }
    const open = /^\s*:{2,}([a-z][\w-]*)(\{.*\})?\s*$/i.exec(line);
    if (open) {
      const title = /title=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/.exec(open[2] ?? '');
      st.figure = plain(open[1]);
      st.label = out.length;
      out.push(`[figure: ${st.figure}${title ? ` · ${title[1] ?? title[2] ?? title[3]}` : ''}]`);
      continue;
    }
    if (/^:{2,}$/.test(bare)) {
      st.figure = null;
      st.props = false;
      continue;
    }
    if (bare === '---') {
      st.props = !st.props;
      continue;
    }
    const title = /^\s*title:\s*(.+)$/.exec(line);
    if (title && st.figure && st.label >= 0) {
      out[st.label] = `[figure: ${st.figure} · ${title[1].trim().replace(/^["']|["']$/g, '')}]`;
      continue;
    }
    // Inside props, or a snippet that starts in the middle of a YAML list.
    if (st.props || /^(\s*…)?\s*-\s*[[{]/.test(line)) out.push(data(line));
    else out.push(line);
  }
  return out;
}

/**
 * Snippet HTML (escaped text + <mark>) → cleaned snippet HTML: `::graph-*` blocks become
 * `[figure: graph-table · Title]`, YAML fences and closing `::` lines go, Mermaid fences become `[diagram]`.
 */
export function cleanSnippet(html: string): string {
  const text = unescape(html.replace(/<mark>/g, OPEN).replace(/<\/mark>/g, CLOSE));
  const joined = cleanLines(text.split('\n'))
    .map((l) => l.trim())
    .filter((l) => plain(l).trim())
    .join(' · ');
  return escape(joined).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}
