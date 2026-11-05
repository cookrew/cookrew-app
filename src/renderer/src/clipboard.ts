// Clipboard access that also works in insecure contexts. The phone companion
// is served over plain LAN HTTP, which is not a secure context, so
// navigator.clipboard is undefined there — every copy path must fall back to
// the legacy hidden-textarea execCommand('copy'). Paste has no insecure
// fallback (execCommand('paste') is dead); phones paste via the composer.

export interface ClipboardEnv {
  /** navigator.clipboard when the context provides one. */
  clipboard:
    | { writeText(text: string): Promise<void>; readText?(): Promise<string> }
    | undefined
  /** Legacy hidden-textarea copy; works in insecure contexts. */
  execCopy: (text: string) => boolean
}

function defaultEnv(): ClipboardEnv {
  return { clipboard: navigator.clipboard, execCopy: execCommandCopy }
}

/** Copy text to the system clipboard. True when some path succeeded. */
export async function writeClipboardText(
  text: string,
  env: ClipboardEnv = defaultEnv()
): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or focus lost — try the legacy path below.
    }
  }
  return env.execCopy(text)
}

/** Clipboard text, or null where reading is impossible (insecure context). */
export async function readClipboardText(
  env: ClipboardEnv = defaultEnv()
): Promise<string | null> {
  if (!env.clipboard?.readText) return null
  try {
    return await env.clipboard.readText()
  } catch {
    return null
  }
}

/**
 * Hidden-textarea execCommand('copy') — the only clipboard write available
 * to insecure contexts. Focus returns to the previously active element so a
 * copy never steals keystrokes from the terminal.
 */
function execCommandCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  active?.focus?.()
  return copied
}

/**
 * Write text that is not here yet — inside the tap that asked for it.
 *
 * Safari writes the clipboard only from a user gesture, and a page's copy
 * comes back from the card a round trip after the Copy tap. A ClipboardItem
 * whose data is a PROMISE is the way through: the write is started in the tap
 * and finishes when the text arrives. Call this synchronously from the tap's
 * handler. Elsewhere, or when that fails, the text is written the plain way
 * once it comes. Resolves with the text and whether it reached the clipboard.
 */
export async function writeClipboardLater(
  text: Promise<string | null>
): Promise<{ text: string | null; ok: boolean }> {
  const board = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (board?.write && Item) {
    const blob = text.then((value) => {
      if (!value) throw new Error('nothing was copied')
      return new Blob([value], { type: 'text/plain' })
    })
    try {
      await board.write([new Item({ 'text/plain': blob })])
      return { text: await text, ok: true }
    } catch {
      // A browser without promise items, or nothing selected: the plain way below.
    }
  }
  const value = await text
  return { text: value, ok: value ? await writeClipboardText(value) : false }
}
