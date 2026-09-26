// Writes small, real PDFs for tests and the visual harness: text in the standard Helvetica fonts,
// wrapped into lines like a word processor would, with an optional outline and "scanned" pages that
// carry only drawings (no text layer).

export interface PdfBlock {
  kind: 'h1' | 'h2' | 'p' | 'li';
  text: string;
}

export interface PdfSpec {
  title?: string;
  /** Each page's blocks, top to bottom. A page with `scanned: true` draws a grey picture instead. */
  pages: { blocks?: PdfBlock[]; scanned?: boolean }[];
  /** Adds an outline (bookmarks) entry for every heading. */
  outline?: boolean;
}

const W = 612;
const H = 792;
const MARGIN = 72;
const STYLE = { h1: { font: 'F2', size: 20, lead: 26 }, h2: { font: 'F2', size: 14, lead: 20 }, p: { font: 'F1', size: 11, lead: 15 }, li: { font: 'F1', size: 11, lead: 15 } } as const;

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Greedy wrap by an average Helvetica glyph width (0.5 em), which is close enough for prose. */
function wrap(text: string, size: number, width: number): string[] {
  const max = Math.floor(width / (size * 0.5));
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > max) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function makePdf(spec: PdfSpec): Buffer {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) - 1 + 1; // object numbers start at 1
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const heads: { title: string; page: number; y: number; level: number }[] = [];
  const pageIds: number[] = [];
  for (const page of spec.pages) {
    let ops = '';
    if (page.scanned) {
      ops = '0.85 g 72 400 468 300 re f 0.6 g 90 430 200 12 re f 90 450 380 12 re f 90 470 330 12 re f\n';
    } else {
      let y = H - MARGIN;
      for (const b of page.blocks ?? []) {
        const st = STYLE[b.kind];
        if (b.kind === 'h1' || b.kind === 'h2') {
          y -= b.kind === 'h1' ? 6 : 10;
          heads.push({ title: b.text, page: pageIds.length, y: y + st.size, level: b.kind === 'h1' ? 1 : 2 });
        }
        const indent = b.kind === 'li' ? 14 : 0;
        const lines = wrap(b.text, st.size, W - 2 * MARGIN - indent);
        lines.forEach((line, i) => {
          const x = MARGIN + indent;
          if (b.kind === 'li' && i === 0) ops += `BT /${st.font} ${st.size} Tf ${MARGIN} ${y} Td (\\225) Tj ET\n`;
          ops += `BT /${st.font} ${st.size} Tf ${x} ${y} Td (${esc(line)}) Tj ET\n`;
          y -= st.lead;
        });
        y -= b.kind === 'li' ? 2 : 9; // paragraph spacing
      }
      ops += `BT /F1 9 Tf ${W / 2 - 4} 40 Td (${pageIds.length + 1}) Tj ET\n`;
    }
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}endstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${content} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`));
  }
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let outlines = '';
  if (spec.outline && heads.length) {
    const root = add('');
    // Top-level entries are the h1s; each h2 hangs under the h1 before it (or the root).
    const items = heads.map((h) => ({ ...h, id: add(''), parent: root, kids: [] as number[] }));
    const top: number[] = [];
    let lastH1: (typeof items)[number] | null = null;
    for (const it of items) {
      if (it.level === 2 && lastH1) {
        it.parent = lastH1.id;
        lastH1.kids.push(it.id);
      } else {
        top.push(it.id);
        if (it.level === 1) lastH1 = it;
      }
    }
    const siblings = (list: number[], id: number) => {
      const i = list.indexOf(id);
      return `${i > 0 ? ` /Prev ${list[i - 1]} 0 R` : ''}${i < list.length - 1 ? ` /Next ${list[i + 1]} 0 R` : ''}`;
    };
    for (const it of items) {
      const list = it.parent === root ? top : items.find((p) => p.id === it.parent)!.kids;
      const kids = it.kids.length ? ` /First ${it.kids[0]} 0 R /Last ${it.kids.at(-1)} 0 R /Count ${it.kids.length}` : '';
      objs[it.id - 1] = `<< /Title (${esc(it.title)}) /Parent ${it.parent} 0 R${siblings(list, it.id)}${kids} /Dest [${pageIds[it.page]} 0 R /XYZ 0 ${it.y} 0] >>`;
    }
    objs[root - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>`;
    outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlines} >>`;
  const info = add(`<< /Title (${esc(spec.title ?? '')}) /Producer (agent-chat tests) >>`);

  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const SENTENCES = [
  'Every write lands in the log before it reaches a table, so a reader can replay the day in order.',
  'The planner weighs each index against the cost of keeping it current under a steady stream of updates.',
  'Pages that are read often stay in the cache, and cold ones are dropped when memory runs short.',
  'Compaction runs at night, when traffic is low, and merges small files into larger sorted runs.',
  'A replica that falls behind catches up from the log rather than from a full copy of the data.',
  'Latency at the ninety-fifth percentile stayed flat while the number of requests grew by two thirds.',
  'Budgets are set per route, and a route over budget blocks its release until it is back under.',
  'The search rollout was the only budget broken this quarter, by about twenty kilobytes.',
  'Backups are restored once a week into a scratch cluster, and the restore time is tracked like any metric.',
  'Schema changes ship behind a flag, so a slow migration can be paused without a rollback.',
];

/** Deterministic filler prose: about `n` words starting at sentence `seed`. */
export function prose(seed: number, n: number): string {
  const out: string[] = [];
  let words = 0;
  for (let i = seed; words < n; i++) {
    const s = SENTENCES[i % SENTENCES.length];
    out.push(s);
    words += s.split(' ').length;
  }
  return out.join(' ');
}

const lower = (s: string) => s[0].toLowerCase() + s.slice(1);

/** A report of `pages` pages: a chapter heading every few pages, sections, paragraphs and a list. */
export function reportPdf(pages: number, opts: { outline?: boolean; title?: string } = {}): Buffer {
  const spec: PdfSpec = { title: opts.title ?? 'Platform report', outline: opts.outline ?? true, pages: [] };
  for (let p = 0; p < pages; p++) {
    const blocks: PdfBlock[] = [];
    if (p === 0) blocks.push({ kind: 'h1', text: opts.title ?? 'Platform report' });
    else if (p % 4 === 0) blocks.push({ kind: 'h1', text: `Chapter ${p / 4 + 1}: Storage and reads` });
    blocks.push({ kind: 'h2', text: `${Math.floor(p / 4) + 1}.${(p % 4) + 1} Section on page ${p + 1}` });
    blocks.push({ kind: 'p', text: `Page ${p + 1} opens here. ${prose(p, 60)}` });
    blocks.push({ kind: 'p', text: prose(p + 1, 70) });
    if (p % 3 === 1) {
      blocks.push({ kind: 'li', text: `First point on page ${p + 1}: ${lower(prose(p + 2, 14))}` });
      blocks.push({ kind: 'li', text: `Second point on page ${p + 1}: ${lower(prose(p + 3, 22))}` });
    }
    blocks.push({ kind: 'p', text: `${prose(p + 4, 50)} Page ${p + 1} ends here.` });
    spec.pages.push({ blocks });
  }
  return makePdf(spec);
}
