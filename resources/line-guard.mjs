/**
 * WHAT SOMEONE ELSE'S SESSION MAY PRINT INTO A PANE OF MINE.
 *
 * An imported card's pane runs orch-line.mjs (orch-mirror.mjs for a local
 * import), and that program prints the bytes another machine sends. The pane's
 * own terminal reads them before any page does. tmux, with `set-clipboard on`
 * as Cookrew sets it (main/pty.ts), ANSWERS an OSC 52 query
 * (`ESC ] 52 ; c ; ? BEL`) by typing its newest copy into the pane, and the
 * program forwards whatever is typed to that other machine. So one short
 * string printed over there read the last thing copied in any pane over here.
 *
 * This stands between the wire and the pane: a clipboard string that asks is
 * dropped whole, and everything else goes through byte for byte. A clipboard
 * string that SETS is let through: selecting in the other side's tmux is
 * copying, and that is how the copy arrives.
 *
 * IT READS A STRING THE WAY THE MOST WILLING TERMINAL DOES, tmux (input.c):
 *   - the string starts at ESC ], and controls between the two are run, not
 *     counted, so they do not hide the opener
 *   - controls inside it are skipped, so they do not hide the number or the `?`
 *   - it is acted on however it is left (BEL, ST, a new ESC, CAN, SUB), so
 *     every one of those is an ending here
 *   - an unfinished string is given up after a few seconds and reading starts
 *     again from the ground, so an ESC ] is looked at wherever it stands,
 *     also inside what looks like another string
 * and the 8-bit controls (U+0080 to U+009F) are taken out altogether: some
 * terminals read U+009D as an opener and U+009C as an ending and tmux reads
 * neither, and two readers of one stream must not be able to disagree.
 *
 * NOTHING IS LET OUT IN HALVES. A lone ESC is held until the next byte says
 * what it began, and a clipboard string is held until it ends, so the pane is
 * never left inside an opener that a later, innocent-looking frame completes.
 * A clipboard string longer than the pane would take is dropped, not flushed.
 *
 * One guard per pane, for the life of the process: its state is the pane's.
 * No imports: this file is shipped beside the two programs and loaded by path.
 */
const ESC = '\x1b'
const BEL = '\x07'
const CAN = '\x18'
const SUB = '\x1a'
/** tmux's own ceiling for a string (input-buffer-size); past it the pane would discard it too. */
const CEILING = 1 << 20
/** How many skipped controls are kept so an innocent sequence passes byte for byte. */
const SLACK = 256

const isControl = (ch) => ch < ' ' || ch === '\x7f'
const isClipboard = (digits) => /^0*52$/.test(digits)

export function clipboardGuard() {
  // ground: nothing held · esc: an ESC (and controls after it) held · osc: a string held · drop: a string being discarded
  let state = 'ground'
  let held = ''
  // What the held string is: not known yet, a clipboard string, or (decided, flushed, back on the ground) any other.
  let clipboard = false
  let digits = ''

  return (chunk) => {
    const text = chunk.replace(/[\x80-\x9f]/g, '')
    let out = ''
    let from = 0
    const toGround = (at) => {
      state = 'ground'
      held = ''
      from = at
    }
    for (let at = 0; at < text.length; ) {
      const ch = text[at]
      if (state === 'ground') {
        if (ch === ESC) {
          out += text.slice(from, at)
          state = 'esc'
          held = ESC
        }
        at++
        continue
      }
      if (state === 'esc') {
        if (ch === ']') {
          state = 'osc'
          held += ch
          clipboard = false
          digits = ''
          at++
        } else if (ch === ESC) {
          // A second ESC starts over. The first is not let out alone: the pane would be left waiting for a `]`.
          out += held.slice(1)
          held = ESC
          at++
        } else if (isControl(ch) && ch !== CAN && ch !== SUB) {
          if (held.length <= SLACK) held += ch
          at++
        } else {
          // Some other sequence. The ESC goes out with the byte that follows it, read again as ground.
          out += held
          toGround(at)
        }
        continue
      }
      // A string, held or being discarded.
      const closes = ch === BEL
      if (closes || ch === ESC || ch === CAN || ch === SUB) {
        const asks = clipboard && held.includes('?')
        if (state === 'osc' && !asks) out += closes ? held + ch : held
        // BEL belongs to the string. Anything else that ends it is read again from the ground.
        at = closes ? at + 1 : at
        toGround(at)
        continue
      }
      at++
      if (state === 'drop') continue
      held += ch
      if (!clipboard && !isControl(ch)) {
        if (ch >= '0' && ch <= '9' && digits.length < 32) digits += ch
        else if (isClipboard(digits) || digits.length >= 32) clipboard = true
        else {
          // Any other string (a title, a link, a colour): shown as it comes.
          out += held
          toGround(at)
          continue
        }
      }
      // Too many skipped controls to tell what it is: judged as a clipboard string.
      if (!clipboard && held.length > SLACK) clipboard = true
      if (clipboard && held.length > CEILING) {
        state = 'drop'
        held = ''
      }
    }
    if (state === 'ground') out += text.slice(from)
    return out
  }
}
