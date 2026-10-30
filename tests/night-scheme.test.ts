// NIGHT (renderer color-scheme.ts + night.css): the phone companion follows a
// phone's dark mode with real night tokens; the desktop app stays paper. On
// 2026-10-30 the owner's Samsung showed the companion force-darkened — grey
// slabs, a black prompt bar, glaring amber — because the page had no dark
// scheme of its own to declare.
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { applyColorScheme, schemeModeFor } from '../src/renderer/src/color-scheme'

const night = readFileSync('src/renderer/src/night.css', 'utf8')
const sheets = execSync("git ls-files 'src/renderer/*.css'", { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.css') && !file.endsWith('night.css'))

const rules = (css: string): Array<{ selectors: string[]; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
    body: m[2]
  }))

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

/** Selectors inside the night sheet's dark blocks that are not scoped to data-scheme auto. */
const unscoped = (css: string): string[] =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('@media (prefers-color-scheme: dark)')
    .slice(1)
    .flatMap((block) => [...block.matchAll(/([^{};]+)\{[^{}]*\}/g)].flatMap((m) => topLevel(m[1])))
    .filter((selector) => !selector.startsWith(":root[data-scheme='auto']"))

describe('which scheme a page follows', () => {
  it('a browser follows the system; the desktop app stays light', () => {
    expect(schemeModeFor(true)).toBe('auto')
    expect(schemeModeFor(false)).toBe('light')
  })

  it('is one attribute on <html>, set before the first paint', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement
    applyColorScheme(true, root)
    expect(root.dataset.scheme).toBe('auto')
    applyColorScheme(false, root)
    expect(root.dataset.scheme).toBe('light')
  })
})

describe('the night sheet', () => {
  it('declares the dark scheme, so a browser stops force-darkening the page', () => {
    expect(night).toMatch(/:root\[data-scheme='auto'\] \{\s*color-scheme: light dark;/)
    expect(night).toMatch(/:root\[data-scheme='light'\] \{\s*color-scheme: light;/)
  })

  it('never reaches the desktop app: every night rule is scoped to data-scheme auto', () => {
    expect(unscoped(night)).toEqual([])
    // The check itself: a bare rule in the dark block is caught.
    expect(unscoped(`${night}\n@media (prefers-color-scheme: dark) {\n  .stg-card { color: red; }\n}`)).toEqual(['.stg-card'])
  })

  it('keeps dark ink on every bright amber or green fill — a new one must be listed', () => {
    const listed = new Set(
      [...night.matchAll(/:is\(([\s\S]*?)\)\s*,/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')))
    )
    const missing: string[] = []
    for (const file of sheets) {
      for (const rule of rules(readFileSync(file, 'utf8'))) {
        if (!/background(?:-color)?\s*:\s*var\(--(?:amber|hp)\)/.test(rule.body)) continue
        for (const selector of rule.selectors) {
          // A pseudo-element draws no text (and cannot sit in :is()).
          if (selector.includes('::') || /^(from|to|\d+%)$/.test(selector)) continue
          if (!listed.has(selector)) missing.push(`${file}: ${selector}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

describe('the phone layout rules', () => {
  it('never nests :has() — a browser drops the whole rule (the dials row collapsed the transcript to 0px)', () => {
    for (const file of sheets) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, file).not.toMatch(/:has\((?:[^()]|\([^()]*\))*:has\(/)
    }
  })
})
