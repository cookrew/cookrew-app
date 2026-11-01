// THE ＋ MENU TAKES OVER THE TERMINAL BUTTON (owner, 2026-11-01: "add a Shell
// and the button on the left can retire"). Everything the button's preset row held — a
// bare shell, the roles, the saved teams, the import, ORCH — sits under the
// prompt box's harness chip, and the button is gone from the zoom view.
//
// Static markup the house way, plus a walk of the element tree to press the
// menu's buttons without a DOM.

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessMenu, type NewMenuActs } from '../src/renderer/src/prompt/HarnessMenu'
import { lastHarness, rememberHarness, SHELL_PRESET } from '../src/renderer/src/prompt/harness-pref'

const stubStorage = (): void => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  }
}

const AT = { left: 10, bottom: 60 }
const HARNESSES = ['Claude Code', 'Codex', 'OpenCode', 'Pi']

const actsWith = (over: Partial<NewMenuActs> = {}): NewMenuActs => ({
  shell: true,
  roles: ['Reviewer'],
  teams: ['baymax-home', 'cookrew-alpha'],
  onPreset: () => undefined,
  onRole: () => undefined,
  onImportServed: () => undefined,
  onOrch: () => undefined,
  making: false,
  ...over
})

type Props = { children?: ReactNode; onClick?: () => void; onChange?: (e: unknown) => void; role?: string }

/** Every element of a rendered tree, depth first. */
const elements = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  return [node, ...elements(node.props.children)]
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join('') : isValidElement<Props>(node) ? text(node.props.children) : node == null || node === false ? '' : String(node)
const press = (tree: ReactNode, label: string): void => {
  const button = elements(tree).find((e) => e.type === 'button' && text(e.props.children).trim().startsWith(label))
  if (!button?.props.onClick) throw new Error(`no button "${label}"`)
  button.props.onClick()
}

describe('the ＋ menu', () => {
  beforeEach(stubStorage)

  it('offers the harnesses as picks, then Shell, the roles, the teams, the import and ORCH', () => {
    const html = renderToStaticMarkup(<HarnessMenu at={AT} harnesses={HARNESSES} harness="Codex" onPick={() => undefined} orch={false} acts={actsWith()} onDone={() => undefined} />)
    for (const name of HARNESSES) expect(html).toContain(`aria-checked="${name === 'Codex'}">${name}</button>`)
    const order = ['OPEN NOW', '>Shell<', 'Reviewer', 'YOUR TEAMS', 'baymax-home', 'cookrew-alpha', '+ Import a team', 'ORCH']
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i > html.indexOf('>Pi<'))).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('checked=""')
  })

  it('Shell, a role and a team are made at once, and the menu closes', () => {
    const presets: string[] = []
    const roles: string[] = []
    const done = vi.fn()
    const acts = actsWith({ onPreset: (n) => void presets.push(n), onRole: (n) => void roles.push(n) })
    const tree = HarnessMenu({ at: AT, harnesses: HARNESSES, harness: 'Codex', onPick: () => undefined, orch: false, acts, onDone: done })
    press(tree, 'Shell')
    press(tree, 'Reviewer')
    press(tree, 'cookrew-alpha')
    expect(presets).toEqual([SHELL_PRESET, 'cookrew-alpha'])
    expect(roles).toEqual(['Reviewer'])
    expect(done).toHaveBeenCalledTimes(3)
  })

  it('a harness is only picked; ORCH toggles and keeps the menu open', () => {
    const picks: string[] = []
    const orch: boolean[] = []
    const done = vi.fn()
    const tree = HarnessMenu({ at: AT, harnesses: HARNESSES, harness: 'Codex', onPick: (n) => void picks.push(n), orch: true, acts: actsWith({ onOrch: (on) => void orch.push(on) }), onDone: done })
    press(tree, 'Pi')
    expect(picks).toEqual(['Pi'])
    const box = elements(tree).find((e) => e.type === 'input')
    box?.props.onChange?.({ target: { checked: false } })
    expect(orch).toEqual([false])
    expect(done).not.toHaveBeenCalled()
  })

  it('while a card is being made the acts hold still, the picks do not', () => {
    const html = renderToStaticMarkup(<HarnessMenu at={AT} harnesses={HARNESSES} harness="Codex" onPick={() => undefined} orch={false} acts={actsWith({ making: true })} onDone={() => undefined} />)
    // Shell + 1 role + 2 teams.
    expect(html.match(/disabled=""/g)?.length).toBe(4)
  })

  it('with nothing to open, it is the harness list alone', () => {
    const html = renderToStaticMarkup(<HarnessMenu at={AT} harnesses={HARNESSES} harness="Codex" onPick={() => undefined} orch={false} onDone={() => undefined} />)
    expect(html).not.toContain('OPEN NOW')
    expect(html).not.toContain('ORCH')
    const bare = renderToStaticMarkup(
      <HarnessMenu at={AT} harnesses={HARNESSES} harness="Codex" onPick={() => undefined} orch={false} acts={actsWith({ shell: false, roles: [], teams: [], onImportServed: undefined })} onDone={() => undefined} />
    )
    expect(bare).not.toContain('OPEN NOW')
    expect(bare).not.toContain('YOUR TEAMS')
    expect(bare).toContain('ORCH')
  })

  it('a shell opened from the menu leaves the harness the box was on', () => {
    rememberHarness('Codex')
    rememberHarness(SHELL_PRESET)
    expect(lastHarness(['Claude Code', 'Codex'])).toBe('Codex')
  })
})

describe('the dock, with the TERMINAL button retired', () => {
  beforeEach(stubStorage)

  const render = async (over: Record<string, unknown> = {}): Promise<string> => {
    vi.resetModules()
    const g = globalThis as Record<string, unknown>
    g.window = g.window ?? globalThis
    const { Dock } = await import('../src/renderer/src/Dock')
    const noop = (): void => undefined
    return renderToStaticMarkup(
      <Dock
        tool="move"
        onSelect={noop}
        clipping={false}
        onToggleClipping={noop}
        presets={['Claude Code', 'Codex', 'Shell', 'my-team']}
        templates={['my-team']}
        preset=""
        onPreset={noop}
        roles={[]}
        role={null}
        onRole={noop}
        orch={false}
        onOrch={noop}
        connectHint={null}
        onMake={noop}
        voiceFor={null}
        agents={[]}
        nodes={[]}
        browserFor={null}
        boardFor={null}
        {...over}
      />
    )
  }

  it('shows no TERMINAL button and no empty tool row; the box leads the dock', async () => {
    const html = await render()
    expect(html).not.toContain('aria-label="TERMINAL"')
    expect(html).not.toContain('cr-dock-tools')
    expect(html).toContain('＋ Claude Code ▾')
  }, 20_000)

  it('the phone has no SOUS key either: the box is the one way in, so no tool row', async () => {
    const html = await render()
    expect(html).not.toContain('aria-label="SOUS"')
    expect(html).not.toContain('cr-dock-tools')
  })

  it('the chip says ORCH while the next agent will lead', async () => {
    expect(await render({ orch: true })).toContain('ORCH</small> ▾')
  })
})
