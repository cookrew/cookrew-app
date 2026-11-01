// THE PROMPT BOX AS A DROP ZONE (owner, 2026-11-01). A screenshot dragged
// over the box shows the transcripts view's DROP TO ATTACH cue over the box
// and, dropped, goes into it as its path. Only the box: the whole page was
// too wide a target. A part inside that takes the drop itself keeps it.

import { describe, expect, it, vi } from 'vitest'
import { listenDropZone } from '../src/renderer/src/prompt/drop-zone'

const SHOT = { name: 'shot.png' } as File

interface Drag extends Event {
  dataTransfer: { types: string[]; files: File[]; dropEffect: string }
}

const drag = (type: string, { files = [SHOT], types = ['Files'] }: { files?: File[]; types?: string[] } = {}): Drag =>
  Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types, files, dropEffect: 'none' } })

/** The box, with `inner` standing in for a part of it that takes a drop itself. */
const box = (inner = false): { target: EventTarget; onOver: ReturnType<typeof vi.fn>; onFiles: ReturnType<typeof vi.fn>; stop: () => void } => {
  const target = new EventTarget()
  if (inner) for (const type of ['dragover', 'drop']) target.addEventListener(type, (e) => e.preventDefault())
  const onOver = vi.fn()
  const onFiles = vi.fn()
  const stop = listenDropZone(target, { onOver, onFiles })
  return { target, onOver, onFiles, stop }
}

describe('the prompt box as a drop zone', () => {
  it('a file dragged over the box shows the cue and claims the drag', () => {
    const { target, onOver } = box()
    const over = drag('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('copy')
    expect(onOver).toHaveBeenLastCalledWith(true)
  })

  it('a dropped screenshot goes to the prompt box, and the cue goes', () => {
    const { target, onOver, onFiles } = box()
    target.dispatchEvent(drag('dragover'))
    const drop = drag('drop')
    target.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).toHaveBeenCalledWith([SHOT])
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drag a part inside took is left to it', () => {
    const { target, onOver, onFiles } = box(true)
    target.dispatchEvent(drag('dragover'))
    expect(onOver).toHaveBeenLastCalledWith(false)
    expect(onOver).not.toHaveBeenCalledWith(true)
    target.dispatchEvent(drag('drop'))
    expect(onFiles).not.toHaveBeenCalled()
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drag of text, not files, is not the box’s', () => {
    const { target, onOver, onFiles } = box()
    const over = drag('dragover', { files: [], types: ['text/plain'] })
    target.dispatchEvent(over)
    target.dispatchEvent(drag('drop', { files: [], types: ['text/plain'] }))
    expect(over.defaultPrevented).toBe(false)
    expect(onOver).not.toHaveBeenCalledWith(true)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('the cue goes when the drag leaves the box, not when it moves from one part to the next', () => {
    const { target, onOver } = box()
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragover'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(true)
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drop another zone took still resets the count, so the next drag can leave', () => {
    const { target, onOver } = box()
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('drop'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragover'))
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('unlistened, the box takes nothing', () => {
    const { target, onOver, onFiles, stop } = box()
    stop()
    const over = drag('dragover')
    target.dispatchEvent(over)
    target.dispatchEvent(drag('drop'))
    expect(over.defaultPrevented).toBe(false)
    expect(onOver).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
  })
})
