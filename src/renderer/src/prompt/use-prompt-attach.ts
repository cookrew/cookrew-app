import { useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { getDraft } from './prompt-draft'
import { pathsForFiles } from '../dropped-files'
import { insertAttached, pastedImages, saveClipboardImages, type Caret } from './prompt-attach'

/**
 * A prompt box's screenshots (prompt-attach.ts): ⌘V of an image, or a file
 * dropped on the box, saved and put into the draft as its path. A text paste
 * is left to the box.
 */

export interface PromptAttach {
  readonly onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void
  readonly onDragOver: (e: React.DragEvent) => void
  readonly onDrop: (e: React.DragEvent) => void
  /** A screenshot is being saved. */
  readonly attaching: boolean
}

interface PromptAttachOptions {
  /** The draft the paths go into (prompt-draft.ts · draftKey). */
  draftKey: string
  /** Writes the draft, and the agent's line with it. */
  write: (text: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Set when nothing may attach here: it says why. */
  refusal?: string | null
  onError: (message: string) => void
}

const carrying = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

const caretOf = (input: HTMLInputElement | null): Caret | null =>
  input && document.activeElement === input && input.selectionStart !== null
    ? { start: input.selectionStart, end: input.selectionEnd ?? input.selectionStart }
    : null

export function usePromptAttach({ draftKey, write, inputRef, refusal = null, onError }: PromptAttachOptions): PromptAttach {
  const [saving, setSaving] = useState(0)
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
        const { text, caret } = insertAttached(then, getDraft(draftKey), at, paths)
        write(text)
        const input = inputRef.current
        if (input && document.activeElement === input) requestAnimationFrame(() => input.setSelectionRange(caret, caret))
      })
      .catch((error: unknown) => {
        console.error('Prompt attachment failed:', error)
        if (mounted.current) onError(`Could not attach: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (mounted.current) setSaving((n) => n - 1)
      })
  }

  return {
    onPaste: (e) => {
      const images = pastedImages(e.clipboardData)
      if (images.length === 0) return
      e.preventDefault()
      attach(() => saveClipboardImages(images, cookrew()))
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
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) attach(() => pathsForFiles(files, cookrew()))
    },
    attaching: saving > 0
  }
}
