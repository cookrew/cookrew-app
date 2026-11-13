// SKINS (owner 2026-11-12, after bowel.dev's thirteen): the whole app's look,
// picked once for the account. A skin recolours the ink palette every surface
// already reads, so these hold the palette to the contrast the app relies on,
// keep every generated rule inside its own skin, and keep the account's pick
// in step across this Mac, its phones and the registry.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SKIN, SKINS, SKIN_IDS, skinFrom, type SkinId } from '../src/shared/skins'
import { applyColorScheme, applyTheme, isNight, themeFrom } from '../src/renderer/src/color-scheme'
import { NIGHT_THEME, PAPER_THEME, ROOT_THEME, terminalTheme } from '../src/renderer/src/terminal-theme'
import {
  LOOKS,
  ON_ACCENT,
  contrast,
  isDrawnSkin,
  paletteOf,
  skinCss,
  skinSwatch,
  skinTerminal,
  sumiTokens,
  type DrawnSkin
} from '../src/renderer/src/skins/skin-look'
import { createSkinStore, readSkin, type SkinAccount } from '../src/main/skin-store'
import { meBody } from '../registry/src/v2-routes'
import type { V2Account } from '../registry/src/v2-accounts'

const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const fakeRoot = (): HTMLElement => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement
const drawn = SKIN_IDS.filter(isDrawnSkin) as DrawnSkin[]

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

/** Every palette a skin can wear: its light one, and its dark one where it has both. */
const palettes = drawn.flatMap((id) => {
  const both = LOOKS[id].light && LOOKS[id].dark
  return both ? [[id, paletteOf(id, false)], [`${id} at night`, paletteOf(id, true)]] : [[id, paletteOf(id, false)]]
}) as [string, ReturnType<typeof paletteOf>][]

describe('the list', () => {
  it('is bowel’s thirteen and Cookrew’s root, ink first and the default', () => {
    expect(SKIN_IDS).toHaveLength(14)
    expect(new Set(SKIN_IDS).size).toBe(14)
    expect(SKINS.map((s) => s.id)).toEqual([...SKIN_IDS])
    expect(DEFAULT_SKIN).toBe('ink')
    expect(SKIN_IDS[0]).toBe('ink')
  })

  it('reads only an exact id; anything else is ink', () => {
    expect(skinFrom('sakura')).toBe('sakura')
    expect(skinFrom('Sakura')).toBe('ink')
    expect(skinFrom(undefined)).toBe('ink')
    expect(themeFrom('obsidian')).toBe('obsidian')
    expect(themeFrom('paper')).toBe('ink')
  })

  it('draws every skin but ink and root from a palette, in the mode the list says', () => {
    expect(drawn).toHaveLength(12)
    for (const skin of SKINS.filter((s) => isDrawnSkin(s.id))) {
      const look = LOOKS[skin.id as DrawnSkin]
      const mode = look.light && look.dark ? 'both' : look.light ? 'light' : 'dark'
      expect(mode, skin.id).toBe(skin.mode)
    }
  })
})

describe('each palette, as the app reads it', () => {
  it.each(palettes)('%s keeps text readable', (_name, p) => {
    const t = sumiTokens(p, '#888888')
    expect(contrast(t['--sumi-ink'], t['--sumi-paper'])).toBeGreaterThanOrEqual(7)
    expect(contrast(t['--sumi-ink-soft'], t['--sumi-paper'])).toBeGreaterThanOrEqual(6)
    expect(contrast(t['--sumi-muted'], t['--sumi-card'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--sumi-wait'], t['--sumi-paper'])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(drawn)('%s puts readable ink on its theme colour and its seal', (id) => {
    const accent = SKINS.find((s) => s.id === id)!.accent
    for (const night of [false, true]) {
      const t = sumiTokens(paletteOf(id, night), accent)
      expect(contrast(t['--sumi-seal-text'], t['--sumi-paper'])).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t['--sumi-on-gold'], t['--sumi-gold'])).toBeGreaterThanOrEqual(3)
      expect(contrast(t['--sumi-on-seal'], t['--sumi-seal-fill'])).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('the sheet a skin wears', () => {
  it.each(drawn)('%s never reaches another skin: every rule is scoped to its own', (id) => {
    const css = bare(skinCss(id)).replace(/@media[^{]*\{/g, '')
    const selectors = [...css.matchAll(/([^{}@;]+)\{[^{}]*\}/g)].flatMap((m) => topLevel(m[1]))
    expect(selectors.length).toBeGreaterThan(5)
    const own = new RegExp(`^html:root(\\[data-scheme='auto'\\])?\\[data-theme='${id}'\\]`)
    expect(selectors.filter((s) => !own.test(s))).toEqual([])
  })

  it.each(drawn)('%s draws its texture on the ground only, and keeps the overview’s grain', (id) => {
    const css = bare(skinCss(id))
    expect(css).not.toMatch(/position:\s*fixed/)
    expect(css).toMatch(new RegExp(`\\[data-theme='${id}'\\] :is\\(body\\.cr-ink, \\.cr-stage\\) \\{[^}]*background-image`))
    expect(css).toMatch(/\.zv-overview \{[^}]*radial-gradient\(var\(--zv-grain\) 1px, transparent 1px\)/)
  })

  it('turns a skin with both sides dark only for a page that follows a dark system', () => {
    const css = bare(skinCss('sakura'))
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*html:root\[data-scheme='auto'\]\[data-theme='sakura'\]/)
    expect(bare(skinCss('neon'))).not.toMatch(/@media/)
  })

  it('inverts the logo on a dark ground, as root does, and leaves it on a light one', () => {
    expect(bare(skinCss('obsidian'))).toMatch(/:is\(\.cr-logo-mark, \.cr-hand-mark\) img \{[^}]*invert\(1\)/)
    expect(bare(skinCss('riso'))).not.toMatch(/invert\(1\)/)
  })

  it('keeps text on a bright fill in step with night.css: the lists never drift', () => {
    const night = bare(readFileSync('src/renderer/src/night.css', 'utf8'))
    const list = night.match(/:is\(([^{}()]*?)\)\s*,/)
    expect(list).not.toBeNull()
    expect([...ON_ACCENT].sort()).toEqual(topLevel(list![1]).sort())
  })

  it('names the agents in the skin’s face', () => {
    expect(skinCss('phosphor')).toMatch(/--font-serif: 'JetBrains Mono'/)
    expect(skinCss('shanshui')).toMatch(/--font-serif: 'Songti SC'/)
  })
})

describe('wearing a skin', () => {
  afterEach(() => {
    applyColorScheme(false, fakeRoot())
    applyTheme('ink', fakeRoot())
  })

  it('is one attribute on <html>, and ink leaves none behind', () => {
    const root = fakeRoot()
    applyTheme('dunhuang', root)
    expect(root.dataset.theme).toBe('dunhuang')
    applyTheme('ink', root)
    expect(root.dataset.theme).toBeUndefined()
  })

  it('draws night for a dark skin everywhere, never for a light one, and as the system says for both', () => {
    applyColorScheme(false, fakeRoot())
    for (const [skin, night] of [['neon', true], ['riso', false], ['sakura', false], ['root', true], ['ink', false]] as [SkinId, boolean][]) {
      applyTheme(skin, fakeRoot())
      expect(isNight(), skin).toBe(night)
    }
  })
})

describe('the live terminal', () => {
  it('keeps ink’s and root’s own palettes', () => {
    expect(terminalTheme('ink', false)).toBe(PAPER_THEME)
    expect(terminalTheme('ink', true)).toBe(NIGHT_THEME)
    expect(terminalTheme('root', false)).toBe(ROOT_THEME)
  })

  it.each(drawn)('%s wears its own ground, ink and cursor', (id) => {
    const night = !LOOKS[id].light
    const theme = terminalTheme(id, night)
    expect(theme).toEqual(skinTerminal(id, night))
    expect(contrast(theme.foreground!, theme.background!)).toBeGreaterThanOrEqual(7)
    expect(contrast(theme.cursor!, theme.background!)).toBeGreaterThanOrEqual(3)
  })
})

describe('the picker’s swatches', () => {
  it('show every skin in its own ground and ink', () => {
    for (const id of SKIN_IDS) {
      const swatch = skinSwatch(id, false)
      expect(contrast(swatch.ink, swatch.card), id).toBeGreaterThanOrEqual(7)
    }
  })
})

describe('the account’s pick, on this Mac', () => {
  let dir = ''
  let file = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'skin-store-'))
    file = path.join(dir, 'nested', 'skin.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** An account that holds `held` (undefined: it cannot be asked) and records what it is sent. */
  const account = (held: SkinId | null | undefined): SkinAccount & { sent: SkinId[] } => {
    const sent: SkinId[] = []
    return {
      sent,
      read: async () => held,
      write: async (skin) => {
        sent.push(skin)
        return true
      }
    }
  }

  it('starts at ink with no file, and reads a damaged one as ink', () => {
    expect(readSkin(file)).toBe('ink')
    writeFileSync(path.join(dir, 'bad.json'), '{not json')
    expect(readSkin(path.join(dir, 'bad.json'))).toBe('ink')
  })

  it('saves a pick, says so, and sends it to the account', async () => {
    const acct = account(undefined)
    const store = createSkinStore({ file, account: acct })
    const heard: string[] = []
    store.bus.on('skin', (skin) => heard.push(skin))
    expect(store.choose('celadon')).toBe('celadon')
    expect(store.choose('not-a-skin')).toBeNull()
    expect(store.get()).toBe('celadon')
    expect(readSkin(file)).toBe('celadon')
    expect(heard).toEqual(['celadon'])
    await Promise.resolve()
    expect(acct.sent).toEqual(['celadon'])
    expect(createSkinStore({ file, account: acct }).get()).toBe('celadon')
  })

  it('takes the account’s pick from another Mac', async () => {
    const store = createSkinStore({ file, account: account('aurora') })
    const heard: string[] = []
    store.bus.on('skin', (skin) => heard.push(skin))
    expect(await store.pull()).toBe('aurora')
    expect(readSkin(file)).toBe('aurora')
    expect(heard).toEqual(['aurora'])
  })

  it('gives an account with no pick this Mac’s, and asks nothing when signed out', async () => {
    writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({ skin: 'riso' }))
    const none = account(null)
    expect(await createSkinStore({ file: path.join(dir, 'skin.json'), account: none }).pull()).toBe('riso')
    expect(none.sent).toEqual(['riso'])
    const out = account(undefined)
    expect(await createSkinStore({ file: path.join(dir, 'skin.json'), account: out }).pull()).toBe('riso')
    expect(out.sent).toEqual([])
  })

  it('drops a pull that crossed a pick: the newer word wins', async () => {
    let resolve: (skin: SkinId) => void = () => undefined
    const store = createSkinStore({
      file,
      account: { read: () => new Promise((r) => (resolve = r)), write: async () => true }
    })
    const pulling = store.pull()
    store.choose('dusk')
    resolve('neon')
    expect(await pulling).toBe('dusk')
    expect(store.get()).toBe('dusk')
  })
})

describe('the registry', () => {
  it('tells the owner the account’s skin, and none for an older account', () => {
    const account = { username: 'drej', displayName: 'Drej', avatar: null, claimedAt: 0, devices: [], desktops: [], recovery: [] } as unknown as V2Account
    expect(meBody(account, 'dev').skin).toBeNull()
    expect(meBody({ ...account, skin: 'blueprint' }, 'dev').skin).toBe('blueprint')
  })
})
