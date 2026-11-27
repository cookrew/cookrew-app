// THE SCREEN A HOSTED AGENT GETS (cli/cookrew-acp.mjs): a plain inline UI the
// pane, the phone and Cookrew's own readers already understand — a `❯ ` box
// between two rules over a `⏎ send` footer, `⏺ title` for a tool call and `⎿`
// for its result, and an approval as a NUMBERED menu whose rows end in
// `esc to cancel`, which shared/wait-choice.ts answers from the box or phone.
//
// Nothing here draws a spinner glyph or says "esc to interrupt": Cookrew reads
// both as a live turn, and an approval waiting under one was never offered
// (measured 2026-11-28).

const dim = (text) => `\x1b[2m${text}\x1b[22m`

export class Screen {
  constructor(write, { name }) {
    this.write = write
    this.name = name
    this.atLineStart = true
    this.buffer = ''
    this.inputDrawn = false
    this.menu = null
    this.model = ''
    this.effort = ''
  }

  width() {
    return Math.max(20, process.stdout.columns || 100)
  }

  print(text) {
    if (!text) return
    this.write(text)
    this.atLineStart = text.endsWith('\n')
  }

  newline() {
    if (!this.atLineStart) this.print('\n')
  }

  shown() {
    const lines = this.buffer.split('\n')
    const last = lines.at(-1)
    const more = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : ''
    const room = this.width() - 6
    return `${last.length > room ? `…${last.slice(-room)}` : last}${more}`
  }

  footer() {
    const parts = [this.name, this.model, this.effort].filter(Boolean)
    return dim(`  ${parts.join(' · ')} · ⏎ send · esc esc stop · /new`)
  }

  drawInput(state) {
    if (this.inputDrawn || state !== 'idle') return
    this.newline()
    const rule = '─'.repeat(this.width() - 1)
    this.write(`${rule}\n❯ ${this.shown()}\n${rule}\n${this.footer()}\x1b[2A\r\x1b[2K❯ ${this.shown()}`)
    this.inputDrawn = true
    this.atLineStart = false
  }

  redrawPrompt() {
    if (this.inputDrawn) this.write(`\r\x1b[2K❯ ${this.shown()}`)
  }

  eraseInput() {
    if (!this.inputDrawn) return
    this.write('\x1b[1A\r\x1b[J')
    this.inputDrawn = false
    this.atLineStart = true
  }

  /** An approval: `what · question` over numbered rows and the footer Cookrew reads. */
  drawMenu(menu) {
    const lines = [`  ${menu.about ? `${menu.about} · ` : ''}${menu.question}`, ...menu.options.map((o, i) => `${i === menu.cursor ? '❯' : ' '} ${i + 1}. ${o.name}`), dim('  esc to cancel · ↑/↓ to move · enter to select')]
    if (menu.drawn) this.write(`\x1b[${menu.drawn}A\r\x1b[J`)
    this.write(`${lines.join('\n')}\n`)
    menu.drawn = lines.length
    this.atLineStart = true
  }

  clearMenu(menu) {
    if (!menu?.drawn) return
    this.write(`\x1b[${menu.drawn}A\r\x1b[J`)
    menu.drawn = 0
    this.atLineStart = true
  }
}
