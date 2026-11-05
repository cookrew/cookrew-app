import type { RemoteState } from '../../../shared/remote-access'
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
