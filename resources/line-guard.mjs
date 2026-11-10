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
 * IT READS A STRING THE WAY THE MOST WILLING TERMINAL DOES, tmux (input.c, 3.6a):
 *   - the string starts at ESC ]; controls between the two are run and every
 *     byte from DEL up is skipped, so neither hides the opener
 *   - controls inside it are skipped, so they do not hide the number or the `?`
 *   - the number is counted in 32 bits and WRAPS, so 4294967348 is 52; a
 *     number is the clipboard's if it is under any width a terminal counts in
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
 * THE OTHER CLIPBOARD PROTOCOL (OSC 5522, kitty's) is taken out whole: tmux
 * does not speak it, a terminal that does may answer it, and nothing a served
 * session prints here has a use for it.
 *
 * THE OTHER HALF, `{ typed: true }`: WHAT IS TYPED BACK. Whatever terminal
 * hosts the pane (tmux, or herdr, whose reader has not been tried against the
 * first half), an answer about the clipboard reaches the other machine only as
 * bytes typed into the pane, which the program forwards. So what is typed
 * passes a guard as well, and that one takes out EVERY clipboard string: a
 * person does not type one. Keys are not held back for it: an ESC goes out
 * with the frame it came in, and a `]` that follows it later is still read as
 * the opener it may be. (The one cost: Alt+] waits for the key after it.)
 *
 * One guard per pane and direction, for the life of the process: its state is
 * the pane's. No imports: this file is shipped beside the two programs and
 * loaded by path.
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

/**
 * Whose number this is: 52 (asks or sets), 5522 (never let through), or 0 for
 * any other string. Read under 16, 32 and 64 bits: a terminal that counts in
 * one of them reads a wrapped number as the small one.
 */
function clipboardNumber(digits) {
  const number = BigInt(digits === '' ? '0' : digits)
  for (const bits of [16n, 32n, 64n]) {
    const read = number % (1n << bits)
    if (read === 52n || read === 5522n) return Number(read)
  }
  return 0
}

/**
 * Words another machine sends for this program to say in its own voice (a
 * refusal's reason): said as words. No control survives, and no more than a
 * line of them.
 */
export const plainText = (value) => (value === undefined || value === null ? '' : String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 200))

export function clipboardGuard(options = {}) {
  const typed = options.typed === true
  // ground: nothing held · esc: an ESC (and controls after it) held · osc: a string held · drop: a string being discarded
  let state = 'ground'
  let held = ''
  // What the held string is: not known yet (''), a clipboard string that is refused when it asks ('asks'),
  // or one refused whatever it says ('always'). Any other string is flushed and read on from the ground.
  let clipboard = ''
  let digits = ''

  return (chunk) => {
    // What is typed is forwarded as typed; what is printed loses the 8-bit controls.
    const text = typed ? chunk : chunk.replace(/[\x80-\x9f]/g, '')
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
          clipboard = ''
          digits = ''
          at++
        } else if (ch === ESC) {
          // A second ESC starts over. Printed, the first is not let out alone: the pane would be left
          // waiting for a `]`. Typed, both are keys (Alt+arrow) and both go.
          out += typed ? held : held.slice(1)
          held = ESC
          at++
        } else if ((isControl(ch) || ch >= '\x7f') && ch !== CAN && ch !== SUB) {
          // Run or skipped by the terminal, which goes on waiting to learn what the ESC began. So does this.
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
        const refused = clipboard === 'always' || (clipboard === 'asks' && (typed || held.includes('?')))
        if (state === 'osc' && !refused) out += closes ? held + ch : held
        // BEL belongs to the string. Anything else that ends it is read again from the ground.
        at = closes ? at + 1 : at
        toGround(at)
        continue
      }
      at++
      if (state === 'drop') continue
      held += ch
      if (clipboard === '' && !isControl(ch)) {
        const whose = ch >= '0' && ch <= '9' ? -1 : clipboardNumber(digits)
        if (whose === -1 && digits.length < 32) digits += ch
        else if (whose === -1) clipboard = 'always' // No string has a number this long.
        else if (whose === 52) clipboard = 'asks'
        else if (whose === 5522) clipboard = 'always'
        else {
          // Any other string (a title, a link, a colour): shown as it comes.
          out += held
          toGround(at)
          continue
        }
      }
      // Too many skipped controls to tell what it is: no honest string looks like that.
      if (clipboard === '' && held.length > SLACK) clipboard = 'always'
      if (clipboard !== '' && held.length > CEILING) {
        state = 'drop'
        held = ''
      }
    }
    if (state === 'ground') out += text.slice(from)
    // A key is not kept waiting: a typed ESC goes out now. The state stays, so a `]` in the next frame is still an opener.
    if (typed && state === 'esc') {
      out += held
      held = ''
    }
    return out
  }
}
