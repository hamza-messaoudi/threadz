// Shared PDF documents in the browser: pdf.js is loaded the first time a PDF is shown, and what it
// produces (documents, text, rendered pages) is kept so scrolling back, zooming and conversation
// updates do not parse or draw anything twice. The layout comes from the server (shared/pdf.ts).
import { useEffect, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { pdfBlocks, type PdfBlock, type PdfLayout, type PdfMetaFields } from '../../../shared/pdf.ts';
import type { DocMeta } from './document.ts';

export type PdfDocMeta = DocMeta & PdfMetaFields;

export const isPdfDoc = (meta: DocMeta | null | undefined): meta is PdfDocMeta => (meta as Partial<PdfDocMeta> | null)?.format === 'pdf';
export const isPdfFile = (f: { name: string; type?: string }) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
export const MAX_PDF_BYTES = 50_000_000;

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

/** pdf.js and its worker, fetched on first use (they are most of a megabyte; most chats never need them). */
export function pdfjs(): Promise<PdfJs> {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  });
  lib.catch(() => (lib = null));
  return lib;
}

interface Held {
  doc: Promise<PDFDocumentProxy>;
  destroy: () => void;
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
  pages: Map<number, Promise<PDFPageProxy>>;
  text: Map<number, Promise<TextContent>>;
}
const held = new Map<string, Held>();
/** A document nobody shows is kept this long, so going back to its conversation is instant. */
const LINGER_MS = 90_000;

/**
 * A stored PDF (`<sha256>.pdf`), parsed once however many views show it. Call the returned release
 * when done; the document is destroyed a while after its last user leaves.
 */
export function acquirePdf(file: string): { doc: Promise<PDFDocumentProxy>; release: () => void } {
  let h = held.get(file);
  if (!h) {
    let task: { destroy(): Promise<void> } | null = null;
    let gone = false;
    const doc = pdfjs().then(async (m) => {
      const base = new URL(`/api/pdfjs/${m.version}/`, location.href).href;
      const t = m.getDocument({
        // Served with immutable caching: a reopened PDF comes from the HTTP cache.
        url: `/api/files/${file}`,
        cMapUrl: `${base}cmaps/`,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
        iccUrl: `${base}iccs/`,
        enableXfa: false,
      });
      task = t;
      if (gone) t.destroy();
      return t.promise;
    });
    const destroy = () => {
      gone = true;
      task?.destroy().catch(() => {});
    };
    h = { doc, destroy, users: 0, timer: null, pages: new Map(), text: new Map() };
    held.set(file, h);
    doc.catch(() => held.delete(file));
  }
  const entry = h;
  entry.users++;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  let released = false;
  return {
    doc: entry.doc,
    release: () => {
      if (released) return;
      released = true;
      if (--entry.users > 0) return;
      entry.timer = setTimeout(() => {
        if (entry.users > 0 || held.get(file) !== entry) return;
        held.delete(file);
        dropBitmaps(file);
        entry.destroy();
      }, LINGER_MS);
    },
  };
}

export function pdfPage(file: string, n: number): Promise<PDFPageProxy> {
  const h = held.get(file);
  if (!h) return Promise.reject(new Error('PDF not held'));
  let p = h.pages.get(n);
  if (!p) {
    p = h.doc.then((d) => d.getPage(n));
    h.pages.set(n, p);
  }
  return p;
}

/** A page's text items, read once: the text layer is rebuilt from them whenever the page comes back. */
export function pageText(file: string, n: number): Promise<TextContent> {
  const h = held.get(file);
  if (!h) return Promise.reject(new Error('PDF not held'));
  let t = h.text.get(n);
  if (!t) {
    t = pdfPage(file, n).then((p) => p.getTextContent());
    h.text.set(n, t);
    t.catch(() => h.text.delete(n));
  }
  return t;
}

// ---- rendered pages: kept as bitmaps within a pixel budget, newest last ----
const BITMAP_BUDGET = 24_000_000;
const bitmaps = new Map<string, { bmp: ImageBitmap; px: number; width: number }>();
let bitmapPx = 0;
const bitmapKey = (file: string, n: number) => `${file}#${n}`;

/** The last drawing of a page, at whatever size it was drawn. */
export function cachedBitmap(file: string, n: number): { bmp: ImageBitmap; width: number } | null {
  const key = bitmapKey(file, n);
  const hit = bitmaps.get(key);
  if (!hit) return null;
  bitmaps.delete(key);
  bitmaps.set(key, hit);
  return hit;
}

export function keepBitmap(file: string, n: number, bmp: ImageBitmap): void {
  const key = bitmapKey(file, n);
  const old = bitmaps.get(key);
  if (old) {
    bitmapPx -= old.px;
    old.bmp.close();
    bitmaps.delete(key);
  }
  const px = bmp.width * bmp.height;
  bitmaps.set(key, { bmp, px, width: bmp.width });
  bitmapPx += px;
  for (const [k, v] of bitmaps) {
    if (bitmapPx <= BITMAP_BUDGET || k === key) break;
    bitmaps.delete(k);
    bitmapPx -= v.px;
    v.bmp.close();
  }
}

function dropBitmaps(file: string) {
  for (const [k, v] of bitmaps)
    if (k.startsWith(`${file}#`)) {
      bitmaps.delete(k);
      bitmapPx -= v.px;
      v.bmp.close();
    }
}

// ---- layout: fetched once per file, small, kept for the session ----
const layouts = new Map<string, Promise<PdfLayout>>();

export function loadLayout(file: string): Promise<PdfLayout> {
  let l = layouts.get(file);
  if (!l) {
    l = fetch(`/api/files/${file}`, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error(`layout ${r.status}`);
      return r.json() as Promise<PdfLayout>;
    });
    layouts.set(file, l);
    l.catch(() => layouts.delete(file));
  }
  return l;
}

const layoutsDone = new Map<string, PdfLayout>();

/** The layout of a PDF document, or null while it loads (or for another kind of document). */
export function usePdfLayout(meta: DocMeta | null | undefined): PdfLayout | null {
  const file = isPdfDoc(meta) ? meta.layout : null;
  const [layout, setLayout] = useState<PdfLayout | null>(() => (file ? (layoutsDone.get(file) ?? null) : null));
  useEffect(() => {
    if (!file) return setLayout(null);
    const done = layoutsDone.get(file);
    if (done) return setLayout(done);
    let live = true;
    loadLayout(file).then(
      (l) => {
        layoutsDone.set(file, l);
        if (live) setLayout(l);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [file]);
  return file ? layout : null;
}

// ---- the text: blocks with their pages, split once per message ----
const blockCache = new Map<string, PdfBlock[]>();

export function pdfBlocksOf(id: string, content: string): PdfBlock[] {
  const key = `${id}:${content.length}`;
  let hit = blockCache.get(key);
  if (!hit) {
    hit = pdfBlocks(content);
    blockCache.set(key, hit);
    if (blockCache.size > 16) blockCache.delete(blockCache.keys().next().value!);
  }
  return hit;
}

/** Shares a PDF: its bytes go up as they are; the server reads the text and layout. */
export async function uploadPdf<T>(threadId: string, file: File): Promise<T> {
  if (file.size > MAX_PDF_BYTES) throw new Error(`${file.name} is too large (over ${MAX_PDF_BYTES / 1_000_000} MB)`);
  const res = await fetch(`/api/threads/${threadId}/documents?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      // not json
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
