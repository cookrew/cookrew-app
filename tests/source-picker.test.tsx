// THE PICKER SHEET (renderer use/SourceSheet.tsx, use/source-sheet.ts): two
// tabs, tiles with a picture, an icon and a title, and a missing grant shown
// as the grant, never as an empty grid. Static markup the house way, plus a
// walk of the element tree to press its buttons without a DOM.
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceSheet, type SourceSheetProps } from '../src/renderer/src/use/SourceSheet'
import { firstTab, settingsSaid, sheetBody, type SourceLoad } from '../src/renderer/src/use/source-sheet'
import { closeSourcePicker, currentSourceAsk, openSourcePicker } from '../src/renderer/src/use/source-picker-store'
import { emptySourceList, readySourceList, type UseSource, type UseSourceList } from '../src/shared/use-sources'

const safari: UseSource = { id: 'window:41', kind: 'window', title: 'Docs', app: 'Safari', address: 'window://Safari?id=41', thumb: 'data:image/jpeg;base64,T', icon: 'data:image/png;base64,I', width: 800, height: 600 }
const bare: UseSource = { ...safari, id: 'window:42', title: 'Mail', app: 'Mail', thumb: null, icon: null }
const main: UseSource = { id: 'screen:main', kind: 'screen', title: 'Main display', app: null, address: 'screen://main', thumb: 'data:image/jpeg;base64,S', icon: null, width: 1728, height: 1117 }
const list: UseSourceList = readySourceList({ windows: [safari, bare], screens: [main] })
const ready: SourceLoad = { status: 'ready', list }
const denied: SourceLoad = {
  status: 'ready',
  list: { ...emptySourceList('needs-permission', 'Screen Recording is off for Cookrew — turn it on'), permission: 'Screen Recording' }
}

const props = (over: Partial<SourceSheetProps> = {}): SourceSheetProps => ({
  load: ready,
  tab: 'windows',
  replacing: false,
  busy: false,
  error: null,
  settingsNote: null,
  canOpenSettings: true,
  onTab: () => undefined,
  onPick: () => undefined,
  onRefresh: () => undefined,
  onSettings: () => undefined,
  onClose: () => undefined,
  ...over
})

type Props = { children?: ReactNode; onClick?: (e?: unknown) => void; role?: string; 'aria-selected'?: boolean; 'aria-label'?: string; disabled?: boolean; className?: string }
const elements = (node: ReactNode): ReactElement<Props>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Props>(node)) return []
  if (typeof node.type === 'function') return elements((node.type as (p: unknown) => ReactNode)(node.props))
  return [node, ...elements(node.props.children)]
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join('') : isValidElement<Props>(node) ? text(node.props.children) : node == null || node === false ? '' : String(node)
const buttonNamed = (tree: ReactNode, label: string): ReactElement<Props> => {
  const hit = elements(tree).find((el) => el.type === 'button' && (el.props['aria-label'] === label || text(el).includes(label)))
  if (!hit) throw new Error(`no button '${label}'`)
  return hit
}

describe('sheetBody', () => {
  it('is the grid of the tab it is on', () => {
    expect(sheetBody(ready, 'windows')).toEqual({ kind: 'grid', sources: [safari, bare] })
    expect(sheetBody(ready, 'screens')).toEqual({ kind: 'grid', sources: [main] })
  })
  it('never an empty grid: no windows is a sentence, and a platform without them says why', () => {
    const none: SourceLoad = { status: 'ready', list: { ...list, windows: [] } }
    expect(sheetBody(none, 'windows').kind).toBe('note')
    const linux: SourceLoad = { status: 'ready', list: { ...list, windows: [], windowsNote: 'macOS only for now' } }
    expect(sheetBody(linux, 'windows')).toEqual({ kind: 'note', text: 'macOS only for now' })
  })
  it('names the permission on either tab', () => {
    for (const tab of ['windows', 'screens'] as const) {
      expect(sheetBody(denied, tab)).toMatchObject({ kind: 'permission', name: 'Screen Recording' })
    }
  })
  it('passes the machine\'s sentence and a failure through', () => {
    expect(sheetBody({ status: 'ready', list: emptySourceList('unavailable', 'This Linux session runs Wayland') }, 'screens')).toEqual({ kind: 'note', text: 'This Linux session runs Wayland' })
    expect(sheetBody({ status: 'failed', error: 'no route' }, 'windows')).toEqual({ kind: 'failed', text: 'no route' })
    expect(sheetBody({ status: 'loading' }, 'windows')).toEqual({ kind: 'loading' })
  })
})

describe('settingsSaid', () => {
  it('says what happened: a refusal is read out, never the instructions for a page that did not open', () => {
    expect(settingsSaid({ ok: false, error: 'no such pane' }, false)).toBe('no such pane')
    expect(settingsSaid({ ok: true }, false)).toMatch(/Turn Cookrew on/)
    expect(settingsSaid(undefined, false)).toMatch(/Turn Cookrew on/)
    expect(settingsSaid({ ok: true }, true)).toMatch(/on your Mac/)
  })
})

describe('firstTab', () => {
  it('opens on Windows, and on Entire screen where there are none', () => {
    expect(firstTab(list)).toBe('windows')
    expect(firstTab({ ...list, windows: [] })).toBe('screens')
    expect(firstTab({ ...list, windows: [], screens: [] })).toBe('windows')
  })
})

describe('SourceSheet', () => {
  it('has the two tabs, the current one selected', () => {
    const tabs = elements(SourceSheet(props())).filter((el) => el.props.role === 'tab')
    expect(tabs.map(text)).toEqual(['Windows', 'Entire screen'])
    expect(tabs.map((t) => t.props['aria-selected'])).toEqual([true, false])
  })

  it('switches tab on a press', () => {
    const onTab = vi.fn()
    buttonNamed(SourceSheet(props({ onTab })), 'Entire screen').props.onClick?.()
    expect(onTab).toHaveBeenCalledWith('screens')
  })

  it('draws a tile as picture, icon and title, and one with no picture from its name', () => {
    const html = renderToStaticMarkup(<SourceSheet {...props()} />)
    expect(html).toContain('src="data:image/jpeg;base64,T"')
    expect(html).toContain('src="data:image/png;base64,I"')
    expect(html).toContain('Docs')
    expect(html).toContain('Safari')
    expect(html).toContain('sp-noshot')
  })

  it('a tap picks that source', () => {
    const onPick = vi.fn()
    buttonNamed(SourceSheet(props({ onPick })), 'Docs').props.onClick?.()
    expect(onPick).toHaveBeenCalledWith(safari)
  })

  it('holds still while a card is being made', () => {
    expect(buttonNamed(SourceSheet(props({ busy: true })), 'Docs').props.disabled).toBe(true)
  })

  it('Screen Recording missing: names it, shows no grid, and the button goes to the settings page', () => {
    const onSettings = vi.fn()
    const tree = SourceSheet(props({ load: denied, onSettings }))
    const html = renderToStaticMarkup(<SourceSheet {...props({ load: denied })} />)
    expect(html).toContain('Cookrew needs Screen Recording')
    expect(html).not.toContain('sp-grid')
    buttonNamed(tree, 'Open Screen Recording settings').props.onClick?.()
    expect(onSettings).toHaveBeenCalledOnce()
  })

  it('says what the press did, for a phone that cannot see the Mac', () => {
    const html = renderToStaticMarkup(<SourceSheet {...props({ load: denied, settingsNote: 'System Settings is open on your Mac.' })} />)
    expect(html).toContain('System Settings is open on your Mac.')
  })

  it('a client with no settings route still names the permission', () => {
    const html = renderToStaticMarkup(<SourceSheet {...props({ load: denied, canOpenSettings: false })} />)
    expect(html).toContain('Screen Recording')
    expect(html).not.toContain('Open Screen Recording settings')
  })

  it('says it is pointing a card at something else when one closed', () => {
    expect(renderToStaticMarkup(<SourceSheet {...props({ replacing: true })} />)).toContain('Pick another window')
  })

  it('shows a failed tap, and a failed list offers another try', () => {
    expect(renderToStaticMarkup(<SourceSheet {...props({ error: 'That window has closed — pick another' })} />)).toContain('That window has closed')
    const onRefresh = vi.fn()
    buttonNamed(SourceSheet(props({ load: { status: 'failed', error: 'no route' }, onRefresh })), 'Try again').props.onClick?.()
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})

describe('the sheet\'s ask', () => {
  it('opens fresh, or for a card, and closes', () => {
    closeSourcePicker()
    expect(currentSourceAsk()).toBeNull()
    openSourcePicker()
    expect(currentSourceAsk()).toEqual({ card: null })
    openSourcePicker({ card: 'c1' })
    expect(currentSourceAsk()).toEqual({ card: 'c1' })
    closeSourcePicker()
    expect(currentSourceAsk()).toBeNull()
  })
})
