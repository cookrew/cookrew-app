/**
 * WHAT A TERMINAL'S OUTPUT MAY DO TO THE CLIPBOARD (OSC 52).
 *
 * The bytes a pane prints are written by whatever runs in it: an agent, a
 * file somebody `cat`s, and on an imported card a session on SOMEONE ELSE'S
 * machine. OSC 52 lets those bytes do two things, and they are not alike.
 *
 *   SET   `ESC ] 52 ; c ; <base64> BEL`. tmux (set-clipboard on) sends its
 *         mouse-drag copies this way, so selecting in a terminal IS copying.
 *         Kept.
 *
 *   ASK   `ESC ] 52 ; c ; ? BEL`. The terminal answers by TYPING the
 *         clipboard into the pane, where the program that asked reads it. A
 *         password copied a minute ago goes to whatever printed nine bytes,
 *         and on an imported card that is a stranger's machine. Refused, in
 *         silence: no read, no answer.
 *
 * The stock addon does both. So it is loaded with a provider that has nothing
 * to read, and a second handler is put in front of it that takes a query and
 * says nothing. xterm asks the handler registered LAST first, and a handler
 * that answers true ends the matter; the order below is the guard.
 *
 * Pasting is not this: it is asked for by a key or a tap, on this side
 * (terminal-clipboard.ts), and reads the clipboard in that gesture.
 */
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard'
import type { Terminal } from '@xterm/xterm'

/** An OSC 52 payload is `<selection>;<data>`; a query's data is the one character `?`. */
export const isClipboardQuery = (payload: string): boolean => payload.split(';')[1] === '?'

export function loadTerminalClipboard(term: Pick<Terminal, 'loadAddon' | 'parser'>, write: (text: string) => Promise<unknown>): void {
  const provider: IClipboardProvider = {
    // Never reached while the guard below stands, and empty if it ever is.
    readText: async () => '',
    writeText: async (_selection, text) => {
      await write(text)
    }
  }
  term.loadAddon(new ClipboardAddon(undefined, provider))
  // AFTER the addon, so before it: a query stops here.
  term.parser.registerOscHandler(52, isClipboardQuery)
}
