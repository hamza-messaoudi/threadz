import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked, type Token, type Tokens } from 'marked';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? '').split(/\s/)[0];
      let html: string;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escapeHtml(text);
      } catch {
        html = escapeHtml(text);
      }
      return `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ''}">${html}</code></pre>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export interface Block {
  index: number;
  raw: string;
  html: string;
}

/**
 * Top-level markdown blocks (space tokens skipped). Indices are stable for immutable (done) messages
 * and match the server's block_index / block_text.
 */
export function toBlocks(source: string): Block[] {
  const tokens = md.lexer(source);
  const links = (tokens as any).links ?? {};
  const blocks: Block[] = [];
  let index = 0;
  for (const tok of tokens as Token[]) {
    if (tok.type === 'space') continue;
    const list = Object.assign([tok], { links });
    const html = DOMPurify.sanitize(md.parser(list as any) as string);
    blocks.push({ index: index++, raw: tok.raw.trim(), html });
  }
  return blocks;
}

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.parse(source) as string);
}
