import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PDF_LAYOUT_VERSION, pdfText, type PdfHeading, type PdfLayout, type PdfMetaFields, type PdfPageLayout } from '../../shared/pdf.ts';
import type { DocumentMeta } from './documents.ts';

/**
 * PDF documents: the same kind of message as a shared Markdown document (meta.kind 'document', with
 * format 'pdf'), whose content_md is the PDF's text (shared/pdf.ts). The text and the layout are
 * extracted once, here, when the PDF is shared; the PDF and its layout are kept under the data
 * directory by content hash, so they never change once written.
 */
export type PdfMeta = DocumentMeta & PdfMetaFields & { path: string };

export const PDF_NAME_RE = /\.pdf$/i;
export const MAX_PDF_BYTES = 50_000_000;

export const isPdfMeta = (meta: object | null | undefined): meta is PdfMeta => (meta as Partial<PdfMeta> | null)?.format === 'pdf';

const require = createRequire(import.meta.url);
/** pdf.js's own data (standard fonts, CMaps, decoders), also served to the web app (server/app.ts). */
export const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
export const pdfjsVersion: string = require('pdfjs-dist/package.json').version;

// Loaded on the first PDF: pdf.js is large and most runs never see one.
let lib: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
const pdfjs = () => (lib ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

interface Item {
  /** Index among the page's text items. */
  k: number;
  str: string;
  /** Baseline start, in points from the unrotated page's top left. */
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
  eol: boolean;
  upright: boolean;
}

interface Line {
  first: number;
  last: number;
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
  text: string;
}

interface Para {
  lines: Line[];
  first: number;
  last: number;
}

const BULLET = /^\s*([•●▪◦‣∙·–—*-]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivx]{1,4}[.)])\s/;
const ENDS_SENTENCE = /[.!?:;]["'”’)\]]?$/;

/** Lines from a page's text items, in content order: a line ends at an end-of-line mark or a jump. */
function linesOf(items: Item[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let broken = true;
  for (const it of items) {
    const blank = !it.str.trim();
    if (blank) {
      // Spaces belong to the line they are in; an empty item only carries an end of line.
      if (cur && !broken && it.str) {
        cur.last = it.k;
        if (!cur.text.endsWith(' ')) cur.text += ' ';
      }
      if (it.eol) broken = true;
      continue;
    }
    const same =
      cur && !broken && it.upright && Math.abs(it.y - cur.y) <= 0.5 * Math.max(it.size, cur.size) && it.x >= cur.x1 - 0.6 * Math.max(it.size, cur.size);
    if (same && cur) {
      if (it.x - cur.x1 > 0.12 * it.size && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
      cur.text += it.str;
      cur.x1 = Math.max(cur.x1, it.x + it.w);
      cur.last = it.k;
      // The line's size and font are its body text's, not a footnote mark's.
      if (it.str.length > 3 && it.size > cur.size) cur.size = it.size;
    } else {
      cur = { first: it.k, last: it.k, x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, font: it.font, text: it.str };
      lines.push(cur);
    }
    broken = it.eol || !it.upright;
  }
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim();
  return lines.filter((l) => l.text);
}

/** Paragraphs from lines: a new one at a change of size, extra space, a list item, an indent, or a short last line. */
function parasOf(lines: Line[], pageWidth: number): Para[] {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    const dy = b.y - a.y;
    if (Math.abs(a.size - b.size) < 0.5 && dy > 0.5 * a.size && dy < 3 * a.size) gaps.push(dy);
  }
  gaps.sort((a, b) => a - b);
  const leading = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : 0;
  const rights = lines.map((l) => l.x1).sort((a, b) => a - b);
  const pageRight = rights.length ? rights[Math.floor(rights.length * 0.9)] : pageWidth;

  const out: Para[] = [];
  let cur: Para | null = null;
  for (const l of lines) {
    const p = cur?.lines.at(-1);
    let split = !cur || !p;
    if (cur && p) {
      const size = Math.max(l.size, p.size);
      const dy = l.y - p.y;
      const right = cur.lines.length > 1 ? Math.max(...cur.lines.map((x) => x.x1)) : pageRight;
      const short = p.x1 < right - 3 * size;
      const bulletFirst = cur.lines.length === 1 && BULLET.test(p.text);
      split =
        Math.abs(l.size - p.size) > 0.15 * size ||
        dy < 0.3 * size ||
        dy > (leading ? leading * 1.35 : p.size * 1.75) ||
        BULLET.test(l.text) ||
        (l.x0 > p.x0 + size && !bulletFirst) ||
        (l.x0 < p.x0 - size && cur.lines.length > 1) ||
        (short && (ENDS_SENTENCE.test(p.text) || l.font !== p.font));
    }
    if (split) {
      cur = { lines: [l], first: l.first, last: l.last };
      out.push(cur);
    } else {
      cur!.lines.push(l);
      cur!.last = l.last;
    }
  }
  return out;
}

/** A paragraph's text on one line: soft hyphens at line ends joined, spaces collapsed. */
function paraText(p: Para): string {
  let text = '';
  for (const l of p.lines) {
    if (!text) text = l.text;
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(l.text)) text = text.slice(0, -1) + l.text;
    else text += ` ${l.text}`;
  }
  return text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

const round = (n: number) => Math.round(n * 10) / 10;

export interface ExtractedPdf {
  /** content_md of the message (shared/pdf.ts). */
  text: string;
  layout: PdfLayout;
  pages: number;
  title: string | null;
  words: number;
  scanned: boolean;
}

/**
 * Reads a PDF's text and layout with pdf.js (the same library, and so the same text items, the web
 * app's text layer is built from). Throws a readable message for a file that is not a usable PDF.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  const { getDocument } = await pdfjs();
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
    wasmUrl: path.join(pdfjsDir, 'wasm') + path.sep,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e: any) {
    await task.destroy().catch(() => {});
    if (e?.name === 'PasswordException') throw new Error('is password-protected');
    throw new Error('could not be read as a PDF');
  }
  try {
    const pages: PdfPageLayout[] = [];
    const texts: string[][] = [];
    const sizes = new Map<number, number>(); // type size → characters set in it
    const heads: { index: number; size: number; text: string; page: number }[] = [];
    let blocks = 0;
    let chars = 0;
    let textless = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const { pageWidth: w, pageHeight: h, pageX, pageY } = vp.rawDims as { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
      const content = await page.getTextContent();
      const items: Item[] = [];
      let k = 0;
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const t = raw.transform as number[];
        items.push({
          k: k++,
          str: raw.str,
          x: t[4] - pageX,
          y: pageY + h - t[5],
          w: raw.width,
          size: Math.hypot(t[2], t[3]) || raw.height || 1,
          font: raw.fontName,
          eol: raw.hasEOL,
          upright: Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 && t[0] > 0,
        });
      }
      const paras = parasOf(linesOf(items), w);
      const kept: { p: Para; text: string }[] = [];
      for (const p of paras) {
        const text = paraText(p);
        if (text) kept.push({ p, text });
      }
      const pageText = kept.map((x) => x.text);
      const pageChars = pageText.reduce((a, s) => a + s.length, 0);
      if (pageChars < 16) textless++;
      chars += pageChars;
      pages.push({
        w: round(w),
        h: round(h),
        r: (((vp.rotation % 360) + 360) % 360) as PdfPageLayout['r'],
        first: blocks,
        paras: kept.map(({ p }) => {
          const x0 = Math.min(...p.lines.map((l) => l.x0));
          const x1 = Math.max(...p.lines.map((l) => l.x1));
          const y0 = Math.min(...p.lines.map((l) => l.y - 0.85 * l.size));
          const y1 = Math.max(...p.lines.map((l) => l.y + 0.25 * l.size));
          return [p.first, p.last + 1, round(x0), round(y0), round(x1), round(y1)];
        }),
      });
      kept.forEach(({ p, text }, i) => {
        const size = Math.round(p.lines[0].size * 2) / 2;
        sizes.set(size, (sizes.get(size) ?? 0) + text.length);
        if (text.length <= 140 && p.lines.length <= 3) heads.push({ index: blocks + i, size, text, page: n });
      });
      blocks += kept.length;
      texts.push(pageText);
      page.cleanup();
    }

    let contents: PdfLayout['contents'] = 'none';
    let headings = await outlineHeadings(doc, pages);
    if (headings.length) contents = 'outline';
    else {
      headings = typeHeadings(heads, sizes);
      if (headings.length >= 2) contents = 'headings';
      else if (pages.length > 1) {
        headings = pages.flatMap((p, i) => (p.paras.length ? [{ index: p.first, level: 1 as const, text: `Page ${i + 1}`, page: i + 1 }] : []));
        contents = headings.length ? 'pages' : 'none';
      } else headings = [];
    }
    const text = pdfText(texts);
    const info = ((await doc.getMetadata().catch(() => null))?.info ?? {}) as { Title?: unknown };
    const metaTitle = typeof info.Title === 'string' ? info.Title.replace(/\s+/g, ' ').trim() : '';
    const title =
      (metaTitle && metaTitle.length < 200 && !/^(untitled|microsoft word\b)|\.(docx?|pdf|pptx?)$/i.test(metaTitle) ? metaTitle : null) ??
      (contents === 'outline' || contents === 'headings' ? headings[0]?.text : null) ??
      null;
    return {
      text,
      layout: { v: PDF_LAYOUT_VERSION, pages, headings, contents },
      pages: doc.numPages,
      title,
      words: texts.flat().reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0),
      scanned: textless > doc.numPages / 2 || chars < 16 * doc.numPages,
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** Headings by type size: the (up to) three sizes above the body text's, largest first. */
function typeHeadings(heads: { index: number; size: number; text: string; page: number }[], sizes: Map<number, number>): PdfHeading[] {
  let body = 0;
  let most = -1;
  for (const [size, n] of sizes) if (n > most) [body, most] = [size, n];
  const big = heads.filter((h) => h.size >= body * 1.12 && /\p{L}/u.test(h.text));
  const levels = [...new Set(big.map((h) => h.size))].sort((a, b) => b - a).slice(0, 3);
  return big.filter((h) => levels.includes(h.size)).map((h) => ({ index: h.index, level: (levels.indexOf(h.size) + 1) as 1 | 2 | 3, text: h.text, page: h.page }));
}

/**
 * The PDF's outline (bookmarks), three levels deep, each entry at the first paragraph at or below its
 * destination. Entries that point nowhere, or at a paragraph an earlier entry has, are left out.
 */
async function outlineHeadings(doc: any, pages: PdfPageLayout[]): Promise<PdfHeading[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const flat: { title: string; dest: unknown; level: 1 | 2 | 3 }[] = [];
  const walk = (items: any[], level: number) => {
    for (const it of items) {
      if (level <= 3) flat.push({ title: String(it.title ?? '').replace(/\s+/g, ' ').trim(), dest: it.dest, level: level as 1 | 2 | 3 });
      if (it.items?.length) walk(it.items, level + 1);
    }
  };
  walk(outline, 1);
  const out: PdfHeading[] = [];
  const seen = new Set<number>();
  for (const e of flat) {
    try {
      const dest = typeof e.dest === 'string' ? await doc.getDestination(e.dest) : e.dest;
      if (!Array.isArray(dest)) continue;
      const ref = dest[0];
      const pi: number = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
      const page = pages[pi];
      if (!page) continue;
      // Destinations give their top in PDF space (y up): XYZ left top zoom, FitH / FitBH top.
      const kind = dest[1]?.name;
      const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
      const y = typeof top === 'number' ? page.h - top : 0;
      let index = -1;
      const at = page.paras.findIndex((p) => p[5] >= y - 2);
      if (at >= 0) index = page.first + at;
      else {
        const next = pages.slice(pi + 1).find((p) => p.paras.length);
        if (next) index = next.first;
      }
      if (index < 0 || seen.has(index) || !e.title) continue;
      seen.add(index);
      out.push({ index, level: e.level, text: e.title, page: pageOfBlock(pages, index) });
    } catch {
      // a broken destination: leave the entry out
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function pageOfBlock(pages: PdfPageLayout[], index: number): number {
  let n = 1;
  for (let i = 0; i < pages.length; i++) if (pages[i].first <= index && pages[i].paras.length) n = i + 1;
  return n;
}

/** Stores a PDF and its layout under `dir` by content hash; returns the meta fields that name them. */
export function storePdf(dir: string, bytes: Uint8Array, layout: PdfLayout): Pick<PdfMeta, 'file' | 'layout' | 'bytes' | 'path'> {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = `${sha}.pdf`;
  const layoutFile = `${sha}.l${layout.v}.json`;
  fs.mkdirSync(dir, { recursive: true });
  const put = (name: string, data: string | Uint8Array) => {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return;
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  };
  put(file, bytes);
  put(layoutFile, JSON.stringify(layout));
  return { file, layout: layoutFile, bytes: bytes.length, path: path.join(dir, file) };
}

/** A stored file's name as the web app asks for it: nothing that could leave the directory. */
export const STORED_FILE_RE = /^[0-9a-f]{64}\.(pdf|l\d+\.json)$/;

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A PDF as the agent reads it: its text with page markers, and where the file itself is (for figures,
 * or for a scan, whose text layer is empty). Like renderDocument, a pure function of meta and text.
 */
export function renderPdf(meta: PdfMeta, content: string): string {
  const note = meta.scanned
    ? `\nThis PDF has little or no text layer (it looks scanned), so the text below is incomplete. To read it, open the file with the Read tool.\n`
    : '\n';
  return `<document name="${attr(meta.name)}" format="pdf" pages="${meta.pages}" file="${attr(meta.path)}">${note}${content.trim()}\n</document>`;
}
