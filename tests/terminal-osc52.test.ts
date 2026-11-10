import { describe, expect, it, vi } from 'vitest'

// The addon's bundle names `self`, as a page has it; this suite runs without a page.
vi.stubGlobal('self', globalThis)

/**
 * WHAT A TERMINAL'S OUTPUT MAY DO TO THE CLIPBOARD (OSC 52). Output is written
 * by whatever runs in the pane: an agent, a file somebody `cat`s, and on an
 * imported card a session on SOMEONE ELSE'S machine. It may set the clipboard
 * (selecting in tmux is copying). It may never ask what the clipboard holds:
 * the answer would be typed into the pane, which on an imported card is a
 * stranger's session.
 */
describe('a terminal’s output and the clipboard', async () => {
  const { default: xtermHeadless } = await import('@xterm/headless')
  const { ClipboardAddon } = await import('@xterm/addon-clipboard')
  const { loadTerminalClipboard, isClipboardQuery } = await import('../src/renderer/src/terminal-osc52')
  type Guarded = Parameters<typeof loadTerminalClipboard>[0]

  const QUERY = '\x1b]52;c;?\x07'
  const SET_HELLO = '\x1b]52;c;aGVsbG8=\x07'
  const terminal = (): InstanceType<typeof xtermHeadless.Terminal> => new xtermHeadless.Terminal({ allowProposedApi: true })
  const written = (term: InstanceType<typeof xtermHeadless.Terminal>, data: string): Promise<void> =>
    new Promise((resolve) => term.write(data, () => setTimeout(resolve, 20)))

  it('the stock addon answers a query by typing the clipboard into the pane: the hazard this guards', async () => {
    const term = terminal()
    const typed: string[] = []
    term.onData((data) => typed.push(data))
    term.loadAddon(new ClipboardAddon(undefined, { readText: async () => 'a secret', writeText: async () => undefined }) as never)
    await written(term, QUERY)
    expect(typed.join('')).toContain(Buffer.from('a secret').toString('base64'))
  })

  it('a query is swallowed: nothing is read, nothing is typed into the pane', async () => {
    const term = terminal()
    const typed: string[] = []
    const write = vi.fn(async () => true)
    term.onData((data) => typed.push(data))
    loadTerminalClipboard(term as unknown as Guarded, write)
    await written(term, QUERY)
    await written(term, '\x1b]52;p;?\x1b\\')
    expect(typed).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it('a copy still lands on the clipboard', async () => {
    const term = terminal()
    const write = vi.fn(async () => true)
    loadTerminalClipboard(term as unknown as Guarded, write)
    await written(term, SET_HELLO)
    expect(write).toHaveBeenCalledWith('hello')
  })

  it('tells a query from a copy by its second field alone', () => {
    expect(isClipboardQuery('c;?')).toBe(true)
    expect(isClipboardQuery(';?')).toBe(true)
    expect(isClipboardQuery('c;aGVsbG8=')).toBe(false)
    expect(isClipboardQuery('c;Pw==')).toBe(false)
    expect(isClipboardQuery('c')).toBe(false)
  })
})
