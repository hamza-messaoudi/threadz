// Shared Shiki highlighter, created on first use. Loaded as a lazy chunk by CodeBlock, so neither Shiki
// nor any grammar is in the initial bundle. JavaScript regex engine (no WASM).
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

export const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<string, Promise<boolean>>();
/** Grammar imports actually started, in order (tests and the network check use it). */
export const loadedGrammars: string[] = [];

function get(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [bundledThemes[THEMES.light](), bundledThemes[THEMES.dark]()],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

/** Loads a grammar once; false for unknown languages (they render as plain text). */
function ensureLanguage(h: HighlighterCore, lang: string): Promise<boolean> {
  let p = loading.get(lang);
  if (!p) {
    const load = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[lang];
    p = load
      ? (loadedGrammars.push(lang),
        load()
          .then((mod) => h.loadLanguage((mod as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default))
          .then(() => true, () => false))
      : Promise.resolve(false);
    loading.set(lang, p);
  }
  return p;
}

/**
 * Highlighted lines as inline HTML (spans and <br>), coloured with --shiki-light / --shiki-dark
 * variables so a theme switch needs no re-highlight. null when the language is unknown.
 */
export async function highlight(code: string, lang: string): Promise<string | null> {
  const h = await get();
  if (!(await ensureLanguage(h, lang))) return null;
  return h.codeToHtml(code, { lang, themes: THEMES, defaultColor: false, structure: 'inline' });
}
