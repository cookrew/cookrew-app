// CLAUDE CODE'S CURSOR ON PAPER (owner, 2026-10-31: "the input box has no
// cursor").
//
// Claude Code hides the terminal's own cursor (`\e[?25l`) and draws one in its
// prompt box: a cell with black text on a WHITE truecolor background
// (`\e[38;2;0;0;0;48;2;255;255;255m `, read off a live pane). On the old dark
// terminal that was a bright block. On the paper (#FFFEF5) it is white on
// cream, and gone. xterm's minimumContrastRatio cannot save it: it moves a
// cell's text colour, never its background.
//
// So on paper the cell is drawn the other way round — ink background, paper
// text — which is what a block cursor on paper looks like. Only that exact
// pair is touched, inside SGR sequences; every other colour passes as sent.
// Night mode keeps it: white on the dark ground is already a block.

const WHITE_BG = '48;2;255;255;255'
const BLACK_FG = '38;2;0;0;0'
const INK_BG = '48;2;45;42;32'
const PAPER_FG = '38;2;255;254;245'

const SGR = /\x1b\[([0-9;]*)m/g

export function paperCursor(chunk: string): string {
  if (!chunk.includes(WHITE_BG)) return chunk
  return chunk.replace(SGR, (whole, params: string) => {
    if (!params.includes(WHITE_BG)) return whole
    const swapped = params.replace(WHITE_BG, INK_BG).replace(BLACK_FG, PAPER_FG)
    return `\x1b[${swapped}m`
  })
}
