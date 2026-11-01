// A phone's keyboard must not resize the layout (owner, 2026-11-01: typing in
// LIVE on an Android phone shrank the shared pane from 27 rows to 10 and back
// on every keyboard open and close).
//
// `interactive-widget=resizes-content` shrinks the LAYOUT viewport on Chrome
// for Android (Samsung Internet included): the zoomed terminal refits and
// resizes the PTY it shares with the desktop. iOS ignores the hint, which is
// why the keyboard auto-rise (styles.css: `.lod-overlay` translates by
// `--kb-inset`) was built and only ever worked there. `resizes-visual` gives
// Android the iOS behaviour the rest of the layout is written for.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { remoteBoot } from '../src/main/mobile-server'

const indexHtml = readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')

describe('the keyboard leaves the layout alone', () => {
  it('the remote boot asks for resizes-visual', () => {
    const boot = remoteBoot(null)
    expect(boot).toContain('interactive-widget=resizes-visual')
    expect(boot).not.toContain('resizes-content')
  })

  it('the page itself asks for resizes-visual', () => {
    expect(indexHtml).toContain('interactive-widget=resizes-visual')
    expect(indexHtml).not.toContain('resizes-content')
  })
})
