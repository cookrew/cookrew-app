// THE ONE AGENT PICKER (WhoPicker.tsx): everything the retired ＋ menu held —
// a bare shell, the saved roles, the window picker — lives in its list now
// with the harnesses, and each harness row wears the harness's OWN mark
// (owner, 2026-11-28: "two agent option frames, make them one, and use the
// harness's original logo").

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { harnessLogo } from '../src/renderer/src/prompt/HarnessGlyph'
import { lastHarness, rememberHarness, SHELL_PRESET } from '../src/renderer/src/prompt/harness-pref'
import { OpenNowRows, WhoPicker, type NewMenuActs } from '../src/renderer/src/prompt/WhoPicker'

const stubStorage = (): void => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  }
}

const HARNESSES = ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Antigravity CLI', 'Devin', 'DeepSeek Harness', 'Alma']
const actsWith = (over: Partial<NewMenuActs> = {}): NewMenuActs => ({
  shell: true,
  roles: ['Reviewer'],
  onPreset: () => undefined,
  onRole: () => undefined,
  making: false,
  ...over
})

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean; role?: string }
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

const picker = (over: { acts?: NewMenuActs; harnesses?: string[] } = {}): React.JSX.Element => (
  <WhoPicker
    rows={[]}
    first={[]}
    recentTitle="recent"
    harnesses={over.harnesses ?? HARNESSES}
    current={{ id: null, harness: 'Codex' }}
    onAgent={() => undefined}
    onNew={() => undefined}
    onClose={() => undefined}
    {...(over.acts ? { acts: over.acts } : {})}
  />
)

describe('the agent picker', () => {
  beforeEach(stubStorage)

  it('is the only frame: the new agents AND what opens at once, Shell and the roles (no teams, no import, no ORCH)', () => {
    const html = renderToStaticMarkup(picker({ acts: actsWith() }))
    expect(html).toContain('new agent')
    expect(html).toContain('open now')
    const order = ['new agent', 'open now', '>Shell<', 'Reviewer']
    const at = order.map((needle) => html.indexOf(needle))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const gone of ['YOUR TEAMS', 'Import a team', 'ORCH']) expect(html).not.toContain(gone)
  })

  it("each harness row wears the harness's own logo", () => {
    const html = renderToStaticMarkup(picker())
    const images = [...html.matchAll(/<img[^>]+class="pf-harness-glyph"[^>]*>/g)].map((m) => m[0])
    expect(images).toHaveLength(HARNESSES.length)
    for (const name of HARNESSES) expect(harnessLogo(name), name).not.toBeNull()
    expect(harnessLogo('Shell')).toBeNull()
  })

  it('has no open-now group when there is nothing to open', () => {
    expect(renderToStaticMarkup(picker())).not.toContain('open now')
  })
})

describe('the picker’s open-now rows', () => {
  it('Shell, a role and the window picker are made at once, and the picker closes', () => {
    const presets: string[] = []
    const roles: string[] = []
    const done = vi.fn()
    const source = vi.fn()
    const tree = OpenNowRows({ acts: actsWith({ onPreset: (n) => void presets.push(n), onRole: (n) => void roles.push(n), onSource: source }), onDone: done })
    press(tree, 'Shell')
    press(tree, 'Reviewer')
    press(tree, 'Window or screen')
    expect(presets).toEqual([SHELL_PRESET])
    expect(roles).toEqual(['Reviewer'])
    expect(source).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledTimes(3)
  })

  it('while a card is being made the acts hold still', () => {
    const html = renderToStaticMarkup(<OpenNowRows acts={actsWith({ making: true, onSource: () => undefined })} onDone={() => undefined} />)
    expect(html.match(/disabled=""/g)?.length).toBe(2)
  })

  it('nothing to open: no rows at all', () => {
    expect(renderToStaticMarkup(<OpenNowRows acts={actsWith({ shell: false, roles: [] })} onDone={() => undefined} />)).toBe('')
  })
})
