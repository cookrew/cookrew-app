// THE PHONE PAGE TAKES A DROPPED SCREENSHOT (owner, 2026-11-01: as the
// transcripts view does). A file dragged anywhere over the page shows the
// DROP TO ATTACH cue and, dropped, goes into the prompt box as its path. A
// zone that takes the drop itself (the transcript, a card's reply box, the
// box) keeps it: the page leaves a drag alone once something cancelled it.

import { describe, expect, it, vi } from 'vitest'
import { listenPageDrop } from '../src/renderer/src/prompt/page-drop'

const SHOT = { name: 'shot.png' } as File

interface Drag extends Event {
  dataTransfer: { types: string[]; files: File[]; dropEffect: string }
}

const drag = (type: string, { files = [SHOT], types = ['Files'] }: { files?: File[]; types?: string[] } = {}): Drag =>
  Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types, files, dropEffect: 'none' } })

/** The page, with `zone` standing in for a part of it that takes a drop itself. */
const page = (zone = false): { target: EventTarget; onOver: ReturnType<typeof vi.fn>; onFiles: ReturnType<typeof vi.fn>; stop: () => void } => {
  const target = new EventTarget()
  if (zone) for (const type of ['dragover', 'drop']) target.addEventListener(type, (e) => e.preventDefault())
  const onOver = vi.fn()
  const onFiles = vi.fn()
  const stop = listenPageDrop(target, { onOver, onFiles })
  return { target, onOver, onFiles, stop }
}

describe('the page as a drop zone', () => {
  it('a file dragged over the page shows the cue and claims the drag', () => {
    const { target, onOver } = page()
    const over = drag('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('copy')
    expect(onOver).toHaveBeenLastCalledWith(true)
  })

  it('a dropped screenshot goes to the prompt box, and the cue goes', () => {
    const { target, onOver, onFiles } = page()
    target.dispatchEvent(drag('dragover'))
    const drop = drag('drop')
    target.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).toHaveBeenCalledWith([SHOT])
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drag something below took (the transcript, a reply box) is left to it', () => {
    const { target, onOver, onFiles } = page(true)
    target.dispatchEvent(drag('dragover'))
    expect(onOver).toHaveBeenLastCalledWith(false)
    expect(onOver).not.toHaveBeenCalledWith(true)
    target.dispatchEvent(drag('drop'))
    expect(onFiles).not.toHaveBeenCalled()
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drag of text, not files, is not the page’s', () => {
    const { target, onOver, onFiles } = page()
    const over = drag('dragover', { files: [], types: ['text/plain'] })
    target.dispatchEvent(over)
    target.dispatchEvent(drag('drop', { files: [], types: ['text/plain'] }))
    expect(over.defaultPrevented).toBe(false)
    expect(onOver).not.toHaveBeenCalledWith(true)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('the cue goes when the drag leaves the page, not when it moves from one part to the next', () => {
    const { target, onOver } = page()
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragover'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(true)
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('a drop another zone took still resets the count, so the next drag can leave', () => {
    const { target, onOver } = page()
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('drop'))
    target.dispatchEvent(drag('dragenter'))
    target.dispatchEvent(drag('dragover'))
    target.dispatchEvent(drag('dragleave'))
    expect(onOver).toHaveBeenLastCalledWith(false)
  })

  it('unlistened, the page takes nothing', () => {
    const { target, onOver, onFiles, stop } = page()
    stop()
    const over = drag('dragover')
    target.dispatchEvent(over)
    target.dispatchEvent(drag('drop'))
    expect(over.defaultPrevented).toBe(false)
    expect(onOver).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
  })
})
