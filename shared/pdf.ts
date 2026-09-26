// A shared PDF document, as both sides read it. The server extracts it once, at upload
// (server/context/pdf.ts): its text goes in the message (content_md) in the form below, and its layout
// (where each paragraph sits on its page) in a file next to the PDF. The web app draws the pages from
// the PDF and threads from the layout; agents read the text.

/**
 * The text: every page opens with a marker line, then its paragraphs, separated by blank lines. A
 * paragraph is one line of text, so the blocks of a PDF (what threads quote, by index) are simply
 * the paragraphs in order.
 */
export const pageMarker = (n: number) => `[Page ${n}]`;

export interface PdfBlock {
  /** 1-based page number. */
  page: number;
  text: string;
}

export function pdfText(pages: string[][]): string {
  return pages.map((paras, i) => [pageMarker(i + 1), ...paras].join('\n\n')).join('\n\n');
}

/** The paragraphs of a PDF's text, with their pages. A marker counts only as the next page's. */
export function pdfBlocks(content: string): PdfBlock[] {
  const out: PdfBlock[] = [];
  let page = 0;
  for (const part of content.split(/\n{2,}/)) {
    const text = part.trim();
    if (!text) continue;
    if (text === pageMarker(page + 1)) page++;
    else out.push({ page: Math.max(page, 1), text });
  }
  return out;
}

/** "page 4", "pages 4–5". */
export function pageSpan(from: number, to = from): string {
  return to > from ? `pages ${from}–${to}` : `page ${from}`;
}

/** Bumped when the extraction changes, so a stored layout always matches the text stored with it. */
export const PDF_LAYOUT_VERSION = 1;

export interface PdfHeading {
  /** The first block under it. */
  index: number;
  level: 1 | 2 | 3;
  text: string;
  page: number;
}

export interface PdfPageLayout {
  /** The unrotated page box, in PDF points. */
  w: number;
  h: number;
  /** Clockwise rotation the page is shown with. */
  r: 0 | 90 | 180 | 270;
  /** Index of the page's first block (the running count of paragraphs before it). */
  first: number;
  /**
   * One entry per paragraph, in block order: [first text item, end item (exclusive), x0, y0, x1, y1].
   * Items count the page's text items (pdf.js getTextContent, marked content excluded), which is also
   * the order of the text layer's spans; the box is in points from the unrotated page's top left.
   */
  paras: number[][];
}

export interface PdfLayout {
  v: number;
  pages: PdfPageLayout[];
  headings: PdfHeading[];
  /** Where the contents come from: the PDF's own outline, headings found by type size, or its pages. */
  contents: 'outline' | 'headings' | 'pages' | 'none';
}

/** The PDF-specific part of a PDF document's message meta (kind 'document', format 'pdf'). */
export interface PdfMetaFields {
  format: 'pdf';
  pages: number;
  /** The stored file, `<sha256>.pdf`: served at /api/files/<file>. */
  file: string;
  /** The stored layout, `<sha256>.l<version>.json`. */
  layout: string;
  bytes: number;
  /** Most pages have no text layer (a scan): agents are pointed at the file itself. */
  scanned?: boolean;
}
