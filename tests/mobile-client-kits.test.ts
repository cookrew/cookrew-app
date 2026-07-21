import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for mobile/client.html — a single hand-maintained file
 * that multiple agents rewrite wholesale, so unrelated feature rewrites have
 * repeatedly (3×) dropped or duplicated entire kits (cr-git chip kit vanished
 * a136f61→d73abb2; the status-coin + title-dedup fixes reverted twice). These
 * cheap grep-count / parse invariants make any such stale rewrite fail loudly
 * in the normal suite, naming exactly what was dropped or duplicated.
 *
 * Counts are pinned to the KNOWN-GOOD state. A drop fails the >= / == checks;
 * a duplicate fails the single-definition checks. Bump a pin deliberately when
 * a kit legitimately grows — never to silence a drop.
 */
const HTML = readFileSync(new URL('../mobile/client.html', import.meta.url), 'utf8')

const count = (needle: string): number => HTML.split(needle).length - 1
const countRe = (re: RegExp): number => (HTML.match(re) ?? []).length

describe('mobile/client.html kit inventory', () => {
  it('defines each render helper exactly once (no wholesale-paste duplicate)', () => {
    expect(count('function coinLed')).toBe(1)
    expect(count('function coinFace')).toBe(1)
    expect(count('function gitChipHtml')).toBe(1)
    expect(count('function agentCardHtml')).toBe(1)
    expect(count('function shellCardHtml')).toBe(1)
  })

  it('keeps the git chip kit (cr-git) present — 21 markers today, never dropped', () => {
    expect(count('cr-git')).toBeGreaterThanOrEqual(20)
  })

  it('keeps the status-coin avatar suite present', () => {
    expect(count('vi-avatar')).toBeGreaterThanOrEqual(9)
    expect(count('vi-coin-led')).toBeGreaterThanOrEqual(1)
    expect(count('coinFace(')).toBeGreaterThanOrEqual(2) // avatar + coin-led both draw it
  })

  it('has the title snippet defined once and NOT rendering a duplicate coin/title', () => {
    // .vi-title-snip CSS rule appears once (single definition).
    expect(countRe(/\.vi-title-snip\s*\{/g)).toBe(1)
    // SUITE-B coin fix: the header must NOT draw a second status coin — the
    // avatar is the status. coinLed survives only for the mini-row + its def.
    expect(count('coinLed')).toBe(3)
    // DEFECT-1 title dedup: the header snippet is title-only (no prompt echo).
    expect(HTML).toContain('const snipSource = activity ? activity.title : null')
    expect(HTML).not.toContain('activity.title || activity.prompt')
  })

  it('carries neither stale fork nor premature checkpoint-elsewhere wording', () => {
    // Mobile is checkpoint-free surface today; must not regress to fork wording.
    expect(countRe(/fork/gi)).toBe(0)
  })

  it('has no exact-duplicate top-level CSS class/id selector block', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(HTML)?.[1] ?? ''
    const selectors = [...css.matchAll(/(?:^|\n) {2}([.#][^\n{]+?)\s*\{/g)].map((m) =>
      m[1].trim()
    )
    const seen = new Map<string, number>()
    for (const sel of selectors) seen.set(sel, (seen.get(sel) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s)
    expect(dupes).toEqual([])
  })

  it('has parseable inline JavaScript (a broken rewrite would crash the app)', () => {
    const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThanOrEqual(1)
    for (const body of scripts) {
      // new Function parses (compiles) the body without running it — browser
      // globals (document, …) are never touched, so only a SYNTAX error throws.
      expect(() => new Function(body)).not.toThrow()
    }
  })
})
