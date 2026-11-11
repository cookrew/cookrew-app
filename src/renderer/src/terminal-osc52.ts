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
 * A SET IS TAKEN ONLY AS A COPY. The clipboard selection (`c`, or none named,
 * which is what tmux sends) and some text: a string that names another
 * selection, or decodes to nothing, would otherwise overwrite or EMPTY the
 * clipboard, and no copy does that.
 *
 * AN ACCEPTED RISK (owner, 2026-11-11): a SET is taken from an imported card
 * too. The session on someone else's machine can therefore put text of its
 * choosing on this clipboard without being asked, and a person who then pastes
 * without looking pastes that. It is kept because it is exactly how a
 * drag-select copy on an imported card arrives (the selection is made in the
 * other side's tmux and comes back as this string), and the two cannot be told
 * apart from here. A rule that took a set only right after this side's own
 * pointer release was considered and not built. What it can never do is read.
 *
 * THIS IS THE PAGE'S HALF. The pane's own terminal reads the same bytes first,
 * and tmux answers a query by itself; on an imported card that half is
 * resources/line-guard.mjs, in front of the pane.
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
    writeText: async (selection, text) => {
      // The type lists the letters; the wire may name none, or several.
      const named: string = selection
      if (text === '' || !(named === '' || named.includes('c'))) return
      await write(text)
    }
  }
  term.loadAddon(new ClipboardAddon(undefined, provider))
  // AFTER the addon, so before it: a query stops here.
  term.parser.registerOscHandler(52, isClipboardQuery)
}
