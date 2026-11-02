// ROOT (owner 2026-11-03: a Mr. Robot look "in the existing style; the logo and the avatars keep their shapes"):
// the ink theme recoloured, not redrawn. One attribute on <html> swaps the
// palette every surface already reads (--sumi-*, through body.cr-ink); the logo
// and the avatars keep their shapes. Ink stays the default.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyColorScheme, applyTheme, isNight, themeFrom } from '../src/renderer/src/color-scheme'
import { NIGHT_THEME, PAPER_THEME, ROOT_THEME, terminalTheme } from '../src/renderer/src/terminal-theme'

const sheet = readFileSync('src/renderer/src/zoom/root-theme.css', 'utf8')
const night = readFileSync('src/renderer/src/night.css', 'utf8')
const main = readFileSync('src/renderer/src/main.tsx', 'utf8')
const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Commas at depth 0 only: a selector list, not the lists inside :is(). */
const topLevel = (list: string): string[] => {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1
    else if (list[i] === ')') depth -= 1
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(from, i))
      from = i + 1
    }
  }
  return [...out, list.slice(from)].map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
}

/** The on-accent list: the first :is(...) that heads a selector list (never inside a rule body). */
const onAccentList = (css: string): string[] => {
  const m = bare(css).match(/:is\(([^{}()]*?)\)\s*,/)
  return m ? topLevel(m[1]).sort() : []
}

const fakeRoot = (): HTMLElement => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement

describe('the theme switch', () => {
  it('reads only an exact "root"; anything else is ink', () => {
    expect(themeFrom('root')).toBe('root')
    expect(themeFrom('ink')).toBe('ink')
    expect(themeFrom(null)).toBe('ink')
    expect(themeFrom('ROOT')).toBe('ink')
  })

  it('is one attribute on <html>, and ink leaves none behind', () => {
    const root = fakeRoot()
    applyTheme('root', root)
    expect(root.dataset.theme).toBe('root')
    applyTheme('ink', root)
    expect(root.dataset.theme).toBeUndefined()
  })

  it('draws the page dark under root, even on the desktop that stays paper', () => {
    applyColorScheme(false, fakeRoot())
    applyTheme('ink', fakeRoot())
    expect(isNight()).toBe(false)
    applyTheme('root', fakeRoot())
    expect(isNight()).toBe(true)
    applyTheme('ink', fakeRoot())
  })
})

describe('the terminal under each theme', () => {
  it('picks root, else night, else paper', () => {
    expect(terminalTheme('root', true)).toBe(ROOT_THEME)
    expect(terminalTheme('root', false)).toBe(ROOT_THEME)
    expect(terminalTheme('ink', true)).toBe(NIGHT_THEME)
    expect(terminalTheme('ink', false)).toBe(PAPER_THEME)
  })

  it('keeps a red cursor on a black ground', () => {
    expect(ROOT_THEME.background.toLowerCase()).toBe('#050706')
    expect(ROOT_THEME.cursor.toLowerCase()).toBe('#ff3b3b')
  })
})

describe('the root sheet', () => {
  it('is loaded after the ink theme, which it recolours', () => {
    const ink = main.indexOf("import './zoom/ink-theme.css'")
    const root = main.indexOf("import './zoom/root-theme.css'")
    expect(ink).toBeGreaterThan(-1)
    expect(root).toBeGreaterThan(ink)
  })

  it('never reaches the ink theme: every rule is scoped to data-theme root', () => {
    const selectors = [...bare(sheet).matchAll(/([^{}@;]+)\{[^{}]*\}/g)].flatMap((m) => topLevel(m[1]))
    expect(selectors.length).toBeGreaterThan(5)
    expect(selectors.filter((s) => !s.startsWith(":root[data-theme='root']"))).toEqual([])
  })

  it('declares a dark scheme, so form controls and scrollbars follow', () => {
    expect(bare(sheet)).toMatch(/:root\[data-theme='root'\] \{[^}]*color-scheme: dark;/)
  })

  it('keeps dark ink on the same bright fills night does: the two lists never drift', () => {
    expect(onAccentList(night).length).toBeGreaterThan(40)
    expect(onAccentList(sheet)).toEqual(onAccentList(night))
  })

  it('draws its scanlines on the ground only, never a layer over text or a page picture', () => {
    const css = bare(sheet)
    expect(css).not.toMatch(/::(?:after|before)\s*\{[^}]*position:\s*fixed/)
    expect(css).toMatch(/:root\[data-theme='root'\] \.zv-overview \{[^}]*repeating-linear-gradient/)
  })

  it('recolours the logo without redrawing it', () => {
    expect(bare(sheet)).toMatch(/:root\[data-theme='root'\] :is\(\.cr-logo-mark, \.cr-hand-mark\) img \{[^}]*filter: invert\(1\)/)
  })
})
