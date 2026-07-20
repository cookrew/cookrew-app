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
