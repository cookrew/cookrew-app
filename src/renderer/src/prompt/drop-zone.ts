import { useEffect, useRef, useState } from 'react'

/**
 * THE PROMPT BOX AS A DROP ZONE (owner, 2026-11-01): a screenshot dragged
 * over the box shows the transcripts view's DROP TO ATTACH cue over the box,
 * and once dropped goes into it as its path (use-prompt-attach.ts ·
 * dropFiles). The whole box takes it, chips and keys included, not only the
 * text field: on a phone the field is a sliver. The page around the box takes
 * nothing (owner: the whole page was too wide a target).
 *
 * Whatever inside the zone takes a drop itself keeps it: the zone leaves
 * alone a drag that reaches it already cancelled.
 */

interface DragLike {
  readonly defaultPrevented: boolean
  readonly dataTransfer?: { readonly types: ArrayLike<string>; readonly files: ArrayLike<File>; dropEffect: string } | null
  preventDefault: () => void
}

export interface DropZoneHandlers {
  /** The cue shows (true) or goes (false). */
  readonly onOver: (over: boolean) => void
  readonly onFiles: (files: File[]) => void
}

const carriesFiles = (e: DragLike): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Listens on `target` (the zone's element) for file drags; returns the unlisten.
 *
 * The cue follows dragover, which fires over and over while a drag hovers:
 * shown where nothing below took the drag, gone where something did. Enter
 * and leave are counted so the cue goes when the drag leaves the zone, and
 * every drop (seen first, in the capture phase) puts the count back to zero,
 * a drop some other zone took included.
 */
export function listenDropZone(target: EventTarget, { onOver, onFiles }: DropZoneHandlers): () => void {
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

/** The element as a drop zone; true while a file drag hovers a part of it that takes none itself. */
export function useDropZone(zone: React.RefObject<HTMLElement | null>, onFiles: (files: File[]) => void): boolean {
  const [over, setOver] = useState(false)
  const take = useRef(onFiles)
  useEffect(() => {
    take.current = onFiles
  })
  useEffect(() => {
    const el = zone.current
    if (!el) return
    const stop = listenDropZone(el, { onOver: setOver, onFiles: (files) => take.current(files) })
    return () => {
      stop()
      setOver(false)
    }
  }, [zone])
  return over
}
