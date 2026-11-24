import { useEffect, useRef, useState } from 'react'
import { cookrew, isRemoteMode } from '../api'
import { oversizeAttachment } from '../../../shared/attachment-limit'
import { attachLimit } from '../rtc-plane'
import { getDraft } from './prompt-draft'
import { pathsForFiles } from '../dropped-files'
import { insertAttached, pastedImages, saveClipboardImages, type Caret } from './prompt-attach'
import { withAttached } from './draft-pictures'

/**
 * A prompt box's screenshots (prompt-attach.ts): ⌘V of an image, or a file
 * dropped on the box, saved and put into the draft as its path. A text paste
 * is left to the box.
 */

export interface PromptAttach {
  readonly onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void
  readonly onDragOver: (e: React.DragEvent) => void
  readonly onDrop: (e: React.DragEvent) => void
  /** Files dropped somewhere else that this box takes (page-drop.ts), or a phone's picker chose. */
  readonly dropFiles: (files: File[]) => void
  /** Pictures pasted somewhere else that this box takes (the folded face's ⌘V). */
  readonly takeImages: (images: File[]) => void
  /** The paperclip on a desktop: the native file dialog, its picks into the draft. */
  readonly pickFiles: () => void
  /** A screenshot is being saved. */
  readonly attaching: boolean
  /** What the attaching is doing now, for the box to say (`compressing · 45%`); null for the plain note. */
  readonly status: string | null
  /** A phone's video or photo is being compressed, and `cancel` stops it. */
  readonly compressing: boolean
  readonly cancel: () => void
}

interface PromptAttachOptions {
  /** The draft the paths go into (prompt-draft.ts · draftKey). */
  draftKey: string
  /** Writes the draft, and the agent's line with it. */
  write: (text: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Set when nothing may attach here: it says why. */
  refusal?: string | null
  /**
   * The box draws its pictures and shows only the words (draft-pictures.ts):
   * the paths go to the end of the draft, and the caret stays in the words.
   */
  aside?: boolean
  onError: (message: string) => void
}

const carrying = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

const caretOf = (input: HTMLInputElement | null): Caret | null =>
  input && document.activeElement === input && input.selectionStart !== null
    ? { start: input.selectionStart, end: input.selectionEnd ?? input.selectionStart }
    : null

export function usePromptAttach({ draftKey, write, inputRef, refusal = null, aside = false, onError }: PromptAttachOptions): PromptAttach {
  const [saving, setSaving] = useState(0)
  /** What each batch of a phone's files is doing, in the order they began (`sendReady`). */
  const [batches, setBatches] = useState<ReadonlyMap<symbol, { said: string | null; compressing: boolean }>>(new Map())
  /** One per batch being made ready; `cancel` stops them all. */
  const stops = useRef<ReadonlySet<AbortController>>(new Set())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const attach = (save: () => Promise<string[]>): void => {
    if (refusal) return onError(refusal)
    const at = caretOf(inputRef.current)
    const then = getDraft(draftKey)
    setSaving((n) => n + 1)
    save()
      .then((paths) => {
        if (aside) return write(withAttached(getDraft(draftKey), paths))
        const { text, caret } = insertAttached(then, getDraft(draftKey), at, paths)
        write(text)
        const input = inputRef.current
        if (input && document.activeElement === input) requestAnimationFrame(() => input.setSelectionRange(caret, caret))
      })
      .catch((error: unknown) => {
        // Stopped by the owner (attach-prepare.ts · AttachStopped, by name so
        // that module stays off the first load): nothing went wrong, nothing is
        // said. A request the network aborted is a failure, and is said.
        if (error instanceof Error && error.name === 'AttachStopped') return
        console.error('Prompt attachment failed:', error)
        if (mounted.current) onError(`Could not attach: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (mounted.current) setSaving((n) => n - 1)
      })
  }

  /**
   * A PHONE'S FILES, MADE READY AND SENT ONE AT A TIME (attach-prepare.ts):
   * a video or a photo compressed to fit the path it would take, the way a
   * chat app sends one, then uploaded before the next is touched — so the
   * phone holds one compressed file at a time and the Mac takes one upload.
   * A desktop hands over paths, which have no cap.
   *
   * Loaded on first use: the box is on every page's first load, the codecs
   * are not. A page whose chunks were replaced by a newer bundle while it was
   * open cannot load them: its files go as they are, within the limit.
   */
  const sendReady = async (files: File[], save: (ready: File[]) => Promise<string[]>): Promise<string[]> => {
    if (!isRemoteMode()) return save(files)
    const tools = await Promise.all([import('./attach-prepare'), import('./attach-media')]).catch((error: unknown) => {
      console.error('Attachment compressing could not load:', error)
      return null
    })
    if (!tools) {
      const said = oversizeAttachment(files, attachLimit())
      if (said) throw new Error(said)
      return save(files)
    }
    const [{ sendOneByOne }, { browserCompressors }] = tools
    const batch = Symbol('batch')
    const stop = new AbortController()
    stops.current = new Set([...stops.current, stop])
    const onNote = (said: string | null, compressing: boolean): void => {
      if (mounted.current) setBatches((now) => new Map([...now, [batch, { said, compressing }]]))
    }
    try {
      return await sendOneByOne(files, save, { limit: attachLimit(), signal: stop.signal, onNote }, browserCompressors)
    } finally {
      stops.current = new Set([...stops.current].filter((other) => other !== stop))
      if (mounted.current) setBatches((now) => new Map([...now].filter(([key]) => key !== batch)))
    }
  }

  const dropFiles = (files: File[]): void => {
    if (files.length > 0) attach(() => sendReady(files, (ready) => pathsForFiles(ready, cookrew())))
  }

  const takeImages = (images: File[]): void => {
    if (images.length > 0) attach(() => sendReady(images, (ready) => saveClipboardImages(ready, cookrew())))
  }

  const latest = [...batches.values()].at(-1)

  return {
    onPaste: (e) => {
      const images = pastedImages(e.clipboardData)
      if (images.length === 0) return
      e.preventDefault()
      takeImages(images)
    },
    onDragOver: (e) => {
      if (!carrying(e)) return
      e.preventDefault()
      // 'copy' even where nothing may attach: the drop then lands, and says why.
      e.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (e) => {
      if (!carrying(e)) return
      e.preventDefault()
      e.stopPropagation()
      dropFiles(Array.from(e.dataTransfer.files))
    },
    dropFiles,
    takeImages,
    // The dialog first: "attaching…" is for the saving, not the choosing.
    // A dialog closed with nothing picked hands back [] and leaves the draft be.
    pickFiles: () => {
      if (refusal) return onError(refusal)
      cookrew()
        .pickFiles()
        .then((paths) => {
          if (paths.length > 0) attach(async () => paths)
        })
        .catch((error: unknown) => {
          console.error('File dialog failed:', error)
          if (mounted.current) onError(`Could not open the file dialog: ${error instanceof Error ? error.message : String(error)}`)
        })
    },
    attaching: saving > 0,
    status: latest?.said ?? null,
    compressing: [...batches.values()].some((b) => b.compressing),
    cancel: () => stops.current.forEach((stop) => stop.abort())
  }
}
