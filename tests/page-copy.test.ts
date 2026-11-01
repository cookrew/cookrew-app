// A browser card's copy reaches the viewer's clipboard (owner 2026-11-01: the
// page said "copied ✓" and nothing pasted). The injected script reports every
// way a page copies text; the cast forwards it only to the viewer who just
// acted on the page.

import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { COPY_BINDING, COPY_WINDOW_MS, MAX_COPY_CHARS, PAGE_COPY_SCRIPT, copyArmed, copyText } from '../src/main/page-copy'

type Listener = (event: unknown) => void

/** Just enough of a page for the script: a clipboard that rejects (headless), a copy event, a selection. */
function fakePage(selection = '') {
  const sent: string[] = []
  const pageWrites: string[] = []
  const listeners: Listener[] = []
  const clipboard = {
    writeText(text: string) {
      pageWrites.push(text)
      return Promise.reject(new Error('Document is not focused.'))
    },
    write(items: unknown[]) {
      pageWrites.push(`items:${items.length}`)
      return Promise.resolve()
    }
  }
  const window: Record<string, unknown> = {
    [COPY_BINDING]: (text: string) => sent.push(text),
    addEventListener: (name: string, listener: Listener) => {
      if (name === 'copy') listeners.push(listener)
    },
    getSelection: () => ({ toString: () => selection })
  }
  const context = { window, navigator: { clipboard }, Promise, Array, String, Object }
  runInNewContext(PAGE_COPY_SCRIPT, context)
  return {
    sent,
    pageWrites,
    clipboard,
    copy: (clipboardText: string | null) =>
      listeners.forEach((l) => l({ clipboardData: clipboardText === null ? null : { getData: () => clipboardText } })),
    rerun: () => runInNewContext(PAGE_COPY_SCRIPT, context),
    listeners
  }
}

describe('the injected script reports what the page copies', () => {
  it('reports writeText, still calls the page’s own, and swallows the headless rejection', async () => {
    const page = fakePage()
    await expect(page.clipboard.writeText('chime: done')).resolves.toBeUndefined()
    expect(page.sent).toEqual(['chime: done'])
    expect(page.pageWrites).toEqual(['chime: done'])
  })

  it('reports the text/plain item of clipboard.write', async () => {
    const page = fakePage()
    const item = { types: ['text/html', 'text/plain'], getType: (type: string) => Promise.resolve({ text: () => Promise.resolve(`as ${type}`) }) }
    await page.clipboard.write([item])
    expect(page.sent).toEqual(['as text/plain'])
    expect(page.pageWrites).toEqual(['items:1'])
  })

  it('reports a copy event: what a handler set, else the selection', () => {
    const page = fakePage('the selected words')
    page.copy('set by the page')
    page.copy('')
    page.copy(null)
    expect(page.sent).toEqual(['set by the page', 'the selected words', 'the selected words'])
  })

  it('reports nothing for an empty copy', () => {
    const page = fakePage('')
    page.copy(null)
    expect(page.sent).toEqual([])
  })

  it('hooks once, however many times it is injected', async () => {
    const page = fakePage('x')
    page.rerun()
    expect(page.listeners).toHaveLength(1)
    await page.clipboard.writeText('once')
    expect(page.sent).toEqual(['once'])
  })
})

describe('the binding’s payload', () => {
  it('takes a non-empty string within the cap, and nothing else', () => {
    expect(copyText('hello')).toBe('hello')
    expect(copyText('')).toBeNull()
    expect(copyText(42)).toBeNull()
    expect(copyText(undefined)).toBeNull()
    expect(copyText('x'.repeat(MAX_COPY_CHARS))).toHaveLength(MAX_COPY_CHARS)
    expect(copyText('x'.repeat(MAX_COPY_CHARS + 1))).toBeNull()
  })
})

describe('only a viewer who just acted gets the copy', () => {
  it('is armed for a few seconds after the viewer’s input, and never without one', () => {
    expect(copyArmed(null, 1_000)).toBe(false)
    expect(copyArmed(1_000, 1_000)).toBe(true)
    expect(copyArmed(1_000, 1_000 + COPY_WINDOW_MS)).toBe(true)
    expect(copyArmed(1_000, 1_001 + COPY_WINDOW_MS)).toBe(false)
    // A clock that went backwards is no input.
    expect(copyArmed(2_000, 1_000)).toBe(false)
  })
})
