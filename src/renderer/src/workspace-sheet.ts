import { useEffect } from 'react'

/**
 * What every sheet over the wall shares. Escape leaves the sheet, not the wall
 * under it: capture, and stopped, so the wall's own Escape never sees it.
 */
export function useSheetEscape(onCancel: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
}

/** A refusal's own sentence: Electron wraps an IPC rejection in its own words. */
export function wordsOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
