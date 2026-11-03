// A PAGE'S COPY, CARRIED TO THE VIEWER'S CLIPBOARD (owner 2026-11-01: a
// browser card's "Copy" button said "copied ✓" and nothing pasted).
//
// A browser card is a headless Chrome whose frames are streamed into the
// card. Whatever the page copies lands on THAT Chrome's clipboard — or on
// none, since a headless browser has no system pasteboard to speak of — never
// on the Mac or the phone the owner is clicking from. So the page's copies are
// caught where they happen and handed to the viewer, which writes its own
// clipboard (useBrowserStream).
//
// How: a CDP binding (`Runtime.addBinding`) the page can call, and a script
// injected into every document that wraps the three ways a page copies text —
// navigator.clipboard.writeText, navigator.clipboard.write with a text/plain
// item, and the `copy` event (execCommand('copy') or ⌘C on a selection). The
// page's own call still runs; a rejection from the headless clipboard is
// swallowed, because the copy DID happen, just elsewhere.
//
// AND THE OTHER WAY: the viewer's own clipboard reaches the page as a paste
// (PASTE_FUNCTION, called by HeadlessInstance.paste) — a paste event first,
// typed text if the page leaves it alone.
//
// WHO MAY WRITE THE OWNER'S CLIPBOARD: a page calls the binding whenever it
// likes, so the binding alone would let any site write the owner's clipboard
// at will. A real browser only lets a page write after a user gesture; the
// same rule holds here — the cast forwards a copy only to the viewer whose own
// input reached the page moments before (copyArmed). Pure, so tested without
// Chrome.

export const COPY_BINDING = '__cookrewCopy'
/** The page-side half of a paste: a real `paste` event carrying the viewer's text. */
export const PASTE_FUNCTION = '__cookrewPaste'

/** How long after the viewer's last input a copy still counts as theirs. */
export const COPY_WINDOW_MS = 5_000

/** More than this is not a copy a person made; it is dropped, not cut. */
export const MAX_COPY_CHARS = 262_144

/**
 * Injected into every document of a card's page (Page.addScriptToEvaluateOnNewDocument)
 * and into the one already loaded. Idempotent: a second run is a no-op.
 */
export const PAGE_COPY_SCRIPT = `(() => {
  if (window.__cookrewCopyHooked) return
  Object.defineProperty(window, '__cookrewCopyHooked', { value: true })
  const send = (text) => {
    try {
      if (typeof text === 'string' && text.length > 0 && typeof window.${COPY_BINDING} === 'function') window.${COPY_BINDING}(text)
    } catch (_) {}
  }
  const board = navigator.clipboard
  if (board) {
    const writeText = typeof board.writeText === 'function' ? board.writeText.bind(board) : null
    if (writeText) {
      board.writeText = (text) => {
        send(String(text))
        return Promise.resolve(writeText(text)).catch(() => undefined)
      }
    }
    const write = typeof board.write === 'function' ? board.write.bind(board) : null
    if (write) {
      board.write = async (items) => {
        try {
          for (const item of items || []) {
            if (item && Array.isArray(item.types) && item.types.includes('text/plain')) {
              send(await (await item.getType('text/plain')).text())
              break
            }
          }
        } catch (_) {}
        return Promise.resolve(write(items)).catch(() => undefined)
      }
    }
  }
  // Bubble phase on window: after the page's own copy handlers, so text a
  // handler set with clipboardData.setData is what is read back.
  window.addEventListener('copy', (event) => {
    let text = ''
    try {
      text = (event.clipboardData && event.clipboardData.getData('text/plain')) || ''
    } catch (_) {}
    if (!text) {
      try {
        text = String(window.getSelection ? window.getSelection() : '')
      } catch (_) {}
    }
    send(text)
  })
  // THE VIEWER'S PASTE, as the page would have seen it: a paste event on the
  // focused element with the text in clipboardData, so an editor that
  // formats or intercepts pastes gets to. True when the page took it over
  // (preventDefault); otherwise main types the text in itself.
  Object.defineProperty(window, '${PASTE_FUNCTION}', {
    value: (text) => {
      let target = document.activeElement || document.body
      while (target && target.shadowRoot && target.shadowRoot.activeElement) target = target.shadowRoot.activeElement
      if (!target) return false
      try {
        const data = new DataTransfer()
        data.setData('text/plain', String(text))
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true })
        target.dispatchEvent(event)
        return event.defaultPrevented
      } catch (_) {
        return false
      }
    }
  })
})()`

/** The copied text out of a binding call, or null for anything that is not one. */
export function copyText(payload: unknown): string | null {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_COPY_CHARS) return null
  return payload
}

/** Did this viewer's own input reach the page recently enough for a copy to be theirs? */
export function copyArmed(lastInputAt: number | null, now: number, windowMs: number = COPY_WINDOW_MS): boolean {
  return lastInputAt !== null && now >= lastInputAt && now - lastInputAt <= windowMs
}
