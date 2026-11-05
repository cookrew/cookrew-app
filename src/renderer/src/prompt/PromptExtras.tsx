import { useRef } from 'react'
import { hasNativeWebview } from '../api'
import { CrIcon } from '../icons'

/**
 * THE BOX'S EXTRA TOOLS (owner, 2026-11-03): 📎 attach and 🔊 spoken replies,
 * for an agent and for a new one alike, behind a ^ that shows or hides them
 * (extras-pref.ts). Every one of them, the ^ too, wears the tray's one pill
 * (owner, 2026-11-04: global-prompt.css · THE TRAY'S TOOLS, ONE FORM).
 *
 * Attach puts the files' paths into the DRAFT, as a pasted or dropped
 * screenshot does (use-prompt-attach.ts): the draft is the agent's own line,
 * and a new agent has no terminal yet to paste into.
 */

/** Keep the caret in the box: a tap on a tool must not take the prompt's focus. */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

export function ExtrasToggle({ shown, speaking, onToggle }: { shown: boolean; speaking: boolean; onToggle: () => void }): React.JSX.Element {
  // Folded, the ^ still says spoken replies are on: nothing else would.
  const heard = speaking && !shown
  return (
    <button
      type="button"
      className={`cr-btn sm cr-tray cr-prompt-more${shown ? ' open' : ''}${heard ? ' speaking' : ''}`}
      title={shown ? 'Hide the tools' : heard ? 'Show the tools: attach, spoken replies (on), the agent\'s keys' : 'Show the tools: attach, spoken replies, the agent\'s keys'}
      aria-label="More tools"
      aria-expanded={shown}
      onMouseDown={keepFocus}
      onClick={onToggle}
    >
      <CrIcon name="chevron-up" />
    </button>
  )
}

/**
 * The phone browser's file picker. It lives in the box itself, never in the
 * tray: the tray is keyed by the box's agent, and a view that moved while the
 * picker was open would unmount it, and the picked files with it.
 */
export function useFilePicker(onFiles: (files: File[]) => void): { open: () => void; input: React.JSX.Element } {
  const ref = useRef<HTMLInputElement>(null)
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      style={{ display: 'none' }}
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? [])
        e.currentTarget.value = ''
        if (files.length > 0) onFiles(files)
      }}
    />
  )
  return { open: () => ref.current?.click(), input }
}

interface PromptExtrasProps {
  /** Nothing attaches to a session elsewhere: the paperclip is left out. */
  canAttach: boolean
  attaching: boolean
  /** The native file dialog (desktop). */
  onPick: () => void
  /** The phone browser's picker (useFilePicker). */
  onBrowse: () => void
  speaking: boolean
  /** A reply is being read now: a tap stops the reading, not spoken replies. */
  reading?: boolean
  onSpeak: () => void
}

export function PromptExtras({ canAttach, attaching, onPick, onBrowse, speaking, reading = false, onSpeak }: PromptExtrasProps): React.JSX.Element {
  const pick = (): void => {
    if (attaching) return
    if (hasNativeWebview()) onPick()
    else onBrowse()
  }
  return (
    <>
      {canAttach && (
        <button
          type="button"
          className={`cr-btn sm cr-tray voice-attach${attaching ? ' busy' : ''}`}
          title="Attach files: their paths go into the prompt"
          aria-label="Attach files"
          disabled={attaching}
          onMouseDown={keepFocus}
          onClick={pick}
        >
          <CrIcon name="attach" />
        </button>
      )}
      <button
        type="button"
        className={`cr-btn sm cr-tray voice-speak${speaking ? ' on' : ''}${speaking && reading ? ' reading' : ''}`}
        title={speaking && reading ? 'Reading the reply: tap to stop reading' : speaking ? 'Spoken replies on: tap to turn off' : 'Speak replies aloud'}
        aria-label="Speak replies aloud"
        aria-pressed={speaking}
        onMouseDown={keepFocus}
        onClick={onSpeak}
      >
        <CrIcon name="speaker" />
      </button>
    </>
  )
}
