// THE PICKER SHEET (renderer use/SourceSheet.tsx, use/source-sheet.ts): two
// tabs, tiles with a picture, an icon and a title, and a missing grant shown
// as the grant, never as an empty grid. Static markup the house way, plus a
// walk of the element tree to press its buttons without a DOM.
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceSheet, type SourceSheetProps } from '../src/renderer/src/use/SourceSheet'
import { firstTab, sheetBody, type SourceLoad } from '../src/renderer/src/use/source-sheet'
import type { RemoteState } from '../src/shared/remote-access'
import { closeSourcePicker, currentSourceAsk, openSourcePicker } from '../src/renderer/src/use/source-picker-store'
import { blockedSourceList, emptySourceList, readySourceList, type UseSource, type UseSourceList } from '../src/shared/use-sources'

const safari: UseSource = { id: 'window:41', kind: 'window', title: 'Docs', app: 'Safari', address: 'window://Safari?id=41', thumb: 'data:image/jpeg;base64,T', icon: 'data:image/png;base64,I', width: 800, height: 600 }
const bare: UseSource = { ...safari, id: 'window:42', title: 'Mail', app: 'Mail', thumb: null, icon: null }
const main: UseSource = { id: 'screen:main', kind: 'screen', title: 'Main display', app: null, address: 'screen://main', thumb: 'data:image/jpeg;base64,S', icon: null, width: 1728, height: 1117 }
const list: UseSourceList = readySourceList({ windows: [safari, bare], screens: [main] })
const ready: SourceLoad = { status: 'ready', list }
const offState: RemoteState = {
  id: 'needs-screen-recording', platform: 'darwin', then: null, detail: null, lastSeenAt: null, until: null, waiting: false,
  build: { settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }
}
const denied: SourceLoad = { status: 'ready', list: blockedSourceList(offState) }

const props = (over: Partial<SourceSheetProps> = {}): SourceSheetProps => ({
  load: ready,
  tab: 'windows',
  replacing: false,
  busy: false,
  error: null,
  remoteDesktop: false,
  where: 'here',
  actNote: null,
  actBusy: false,
  onTab: () => undefined,
  onPick: () => undefined,
  onRefresh: () => undefined,
  onAct: () => undefined,
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
  it('shows the desk\'s state on either tab, the same one the card shows', () => {
    for (const tab of ['windows', 'screens'] as const) {
      expect(sheetBody(denied, tab)).toMatchObject({ kind: 'remote', state: { id: 'needs-screen-recording' } })
    }
  })
  it('passes the machine\'s sentence and a failure through', () => {
    expect(sheetBody({ status: 'ready', list: emptySourceList('unavailable', 'This Linux session runs Wayland') }, 'screens')).toEqual({ kind: 'note', text: 'This Linux session runs Wayland' })
    expect(sheetBody({ status: 'failed', error: 'no route' }, 'windows')).toEqual({ kind: 'failed', text: 'no route' })
    expect(sheetBody({ status: 'loading' }, 'windows')).toEqual({ kind: 'loading' })
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

  it('Screen Recording missing: the state and its next action, and no grid', () => {
    const html = renderToStaticMarkup(<SourceSheet {...props({ load: denied })} />)
    expect(html).toContain('Screen Recording is off')
    expect(html).toContain('Turn on Electron')
    expect(html).toContain('Open System Settings')
    expect(html).not.toContain('sp-grid')
  })

  it('says what the press did, for a phone that cannot see the Mac', () => {
    const html = renderToStaticMarkup(<SourceSheet {...props({ load: denied, where: 'away', actNote: 'System Settings is open on the Mac for when you are there.' })} />)
    expect(html).toContain('System Settings is open on the Mac for when you are there.')
    expect(html).toContain('needs you at the Mac')
    expect(html).toContain('Open it on the Mac for later')
  })

  it('from the machine it goes by its name, Remote desktop', () => {
    expect(renderToStaticMarkup(<SourceSheet {...props({ remoteDesktop: true })} />)).toContain('Remote desktop')
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
