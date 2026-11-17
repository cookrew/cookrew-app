/**
 * THE SITE IN TWO LANGUAGES (owner 2026-11-18): English at /, Chinese at /zh/. The pages are drawn once per language;
 * while one language is being drawn, `tr` picks its words and `local` turns a site path into that language's. English
 * stays exactly as it was. Pages with no Chinese copy (the legal pages, /open, /join) are drawn in English only, and a
 * Chinese page links to them as they are.
 */
export type Lang = 'en' | 'zh'

let lang: Lang = 'en'

/** Draw `render` in `l`; finished when it returns, like withStaticSite. */
export function withLang<T>(l: Lang, render: () => T): T {
  const was = lang
  lang = l
  try {
    return render()
  } finally {
    lang = was
  }
}

export const currentLang = (): Lang => lang

/** The words for the language being drawn. */
export const tr = (en: string, zh: string): string => (lang === 'zh' ? zh : en)

/** The site's paths that have a Chinese page: the front page and the feature pages. */
const TRANSLATED = (path: string): boolean => path === '/' || path.startsWith('/#') || path.startsWith('/features/')

/** A site path in the language being drawn ('/', '/#start', '/features/canvas'); other paths and URLs as they are. */
export function local(path: string): string {
  if (lang === 'en' || !path.startsWith('/') || !TRANSLATED(path)) return path
  return path === '/' ? '/zh/' : path.startsWith('/#') ? `/zh/${path.slice(1)}` : `/zh${path}`
}

/** The same page in the other language, for the switch in the header. */
export function otherLang(path: string): { href: string; label: string; lang: Lang } {
  if (lang === 'en') return { href: TRANSLATED(path) ? (path === '/' ? '/zh/' : `/zh${path}`) : '/zh/', label: '中文', lang: 'zh' }
  return { href: path, label: 'English', lang: 'en' }
}

/** The html lang attribute. */
export const htmlLang = (): string => (lang === 'zh' ? 'zh-CN' : 'en')
