import type { UseSource, UseSourceList, UseSourceSettings } from '../../../shared/use-sources'

/** What the picker sheet draws, from what main answered: never an empty grid. */

export type SourceTab = 'windows' | 'screens'

export type SourceLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'ready'; readonly list: UseSourceList }

export type SheetBody =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'permission'; readonly name: string; readonly text: string }
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
  if (list.state === 'needs-permission') {
    return { kind: 'permission', name: list.permission ?? 'A permission', text: list.message ?? '' }
  }
  if (list.state === 'unavailable') return { kind: 'note', text: list.message ?? NOTHING[tab] }
  const sources = tab === 'windows' ? list.windows : list.screens
  if (sources.length > 0) return { kind: 'grid', sources }
  return { kind: 'note', text: (tab === 'windows' ? list.windowsNote : null) ?? NOTHING[tab] }
}

/** What the settings button did, said to someone who may be looking at a phone. */
export function settingsSaid(answer: UseSourceSettings | undefined, remote: boolean): string {
  if (answer?.ok === false) return answer.error
  return remote ? 'System Settings is open on your Mac: turn Cookrew on there, then restart Cookrew.' : 'Turn Cookrew on in System Settings, then restart Cookrew.'
}

/** Where the sheet opens: Windows, unless only displays can be shared here. */
export const firstTab = (list: UseSourceList): SourceTab => (list.windows.length === 0 && list.screens.length > 0 ? 'screens' : 'windows')
