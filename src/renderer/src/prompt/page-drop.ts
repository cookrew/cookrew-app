import { useEffect, useRef, useState } from 'react'

/**
 * THE PHONE PAGE TAKES A DROPPED SCREENSHOT (owner, 2026-11-01): the way the
 * transcripts view does. A file dragged anywhere over the page shows the
 * same DROP TO ATTACH cue, and once dropped it goes into the prompt box as
 * its path (use-prompt-attach.ts · dropFiles), as a drop on the box itself
 * does. On a phone the box is a short strip at the foot; the page is what a
 * finger can hit.
 *
 * Whatever takes a drop itself keeps it: the transcript (TerminalOverlay),
 * a card's reply box and the prompt box cancel the drag where it is, so the
 * page leaves alone any drag that arrives here already cancelled.
 */

interface DragLike {
  readonly defaultPrevented: boolean
  readonly dataTransfer?: { readonly types: ArrayLike<string>; readonly files: ArrayLike<File>; dropEffect: string } | null
  preventDefault: () => void
}

export interface PageDropHandlers {
  /** The cue shows (true) or goes (false). */
  readonly onOver: (over: boolean) => void
  readonly onFiles: (files: File[]) => void
}

const carriesFiles = (e: DragLike): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Listens on `target` (the window) for file drags; returns the unlisten.
 *
 * The cue follows dragover, which fires over and over while a drag hovers:
 * shown where nothing below took the drag, gone where something did. Enter
 * and leave are counted so the cue goes when the drag leaves the page, and
 * every drop (seen first, in the capture phase) puts the count back to zero,
 * a drop some other zone took included.
 */
export function listenPageDrop(target: EventTarget, { onOver, onFiles }: PageDropHandlers): () => void {
  let depth = 0
  const done = (): void => {
    depth = 0
    onOver(false)
  }
  const enter = (e: Event): void => {
    if (carriesFiles(e as unknown as DragLike)) depth += 1
  }
  const leave = (e: Event): void => {
    if (!carriesFiles(e as unknown as DragLike)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) onOver(false)
  }
  const over = (e: Event): void => {
    const drag = e as unknown as DragLike
    if (!carriesFiles(drag)) return
    if (drag.defaultPrevented) return onOver(false)
    drag.preventDefault()
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'copy'
    onOver(true)
  }
  const drop = (e: Event): void => {
    const drag = e as unknown as DragLike
    if (!carriesFiles(drag) || drag.defaultPrevented) return
    drag.preventDefault()
    const files = Array.from(drag.dataTransfer?.files ?? [])
    if (files.length > 0) onFiles(files)
  }
  const listeners: ReadonlyArray<readonly [string, (e: Event) => void, boolean]> = [
    ['dragenter', enter, false],
    ['dragleave', leave, false],
    ['dragover', over, false],
    ['drop', done, true],
    ['drop', drop, false],
    ['dragend', done, false]
  ]
  for (const [type, fn, capture] of listeners) target.addEventListener(type, fn, capture)
  return () => {
    for (const [type, fn, capture] of listeners) target.removeEventListener(type, fn, capture)
  }
}

/** The page as a drop zone while `enabled`; true while a file drag hovers a part of it that takes none itself. */
export function usePageDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false)
  const take = useRef(onFiles)
  useEffect(() => {
    take.current = onFiles
  })
  useEffect(() => {
    if (!enabled) return
    const stop = listenPageDrop(window, { onOver: setOver, onFiles: (files) => take.current(files) })
    return () => {
      stop()
      setOver(false)
    }
  }, [enabled])
  return enabled && over
}
