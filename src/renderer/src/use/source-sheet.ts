import { remoteView, type RemoteAction, type RemoteState, type RemoteWhere, type UnlockReach } from '../../../shared/remote-access'
import type { UseSource, UseSourceList } from '../../../shared/use-sources'

/** What the picker sheet draws, from what main answered: never an empty grid. */

export type SourceTab = 'windows' | 'screens'

export type SourceLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'ready'; readonly list: UseSourceList }

export type SheetBody =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'remote'; readonly state: RemoteState }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'grid'; readonly sources: readonly UseSource[] }

const NOTHING: Record<SourceTab, string> = {
  windows: 'No windows are open on this screen',
  screens: 'No displays were found'
}

export function sheetBody(load: SourceLoad, tab: SourceTab): SheetBody {
  if (load.status === 'loading') return { kind: 'loading' }
  if (load.status === 'failed') return { kind: 'failed', text: load.error }
  const { list } = load
  if (list.remote) return { kind: 'remote', state: list.remote }
  if (list.state === 'unavailable') return { kind: 'note', text: list.message ?? NOTHING[tab] }
  const sources = tab === 'windows' ? list.windows : list.screens
  if (sources.length > 0) return { kind: 'grid', sources }
  return { kind: 'note', text: (tab === 'windows' ? list.windowsNote : null) ?? NOTHING[tab] }
}

/** Where the sheet opens: Windows, unless only displays can be shared here. */
export const firstTab = (list: UseSourceList): SourceTab => (list.windows.length === 0 && list.screens.length > 0 ? 'screens' : 'windows')

/** What the sheet does without a tap: there is only one way on, so it takes it. */
export type SheetStep = { readonly kind: 'pick'; readonly source: UseSource } | { readonly kind: 'act'; readonly action: RemoteAction } | null

/**
 * Asked for as the remote desktop, the reader came for the screen. One screen
 * is opened at once; a locked Mac that can be unlocked from here opens the
 * unlock sheet at once, and an unpaired browser is not sent into a sheet that
 * can only ask for a pairing it cannot get. Anything with a choice in it waits for the tap.
 */
export function autoStep(load: SourceLoad, remoteDesktop: boolean, where: RemoteWhere, reach: UnlockReach = 'ready'): SheetStep {
  if (!remoteDesktop || load.status !== 'ready') return null
  const { list } = load
  if (list.remote) {
    if (list.remote.id !== 'locked') return null
    const unlock = remoteView(list.remote, where, Date.now(), reach).actions.find((action) => action.id === 'unlock')
    return unlock ? { kind: 'act', action: unlock } : null
  }
  return list.state === 'ready' && list.screens.length === 1 ? { kind: 'pick', source: list.screens[0] } : null
}
