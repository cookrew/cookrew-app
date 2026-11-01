// The card that says why a terminal cannot resolve names (owner, 2026-11-01).
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { oldLoginSentence, TerminalSessionNotice } from '../src/renderer/src/TerminalSessionNotice'

const stale = { stale: true, serverPid: 1201, serverStartedAt: new Date(2026, 9, 30, 1, 28).getTime(), loginAt: new Date(2026, 9, 31, 20, 28).getTime() }

describe('terminals from an earlier login, said', () => {
  it('names the fault, both times, the pid, the fix and what the fix costs', () => {
    const s = oldLoginSentence(stale) ?? ''
    expect(s).toMatch(/earlier macOS login/)
    expect(s).toMatch(/host names do not resolve/)
    expect(s).toContain('pid 1201')
    expect(s).toMatch(/closes every terminal/)
  })

  it('says nothing for a server of this login, or when a time is unknown', () => {
    expect(oldLoginSentence({ ...stale, stale: false })).toBeNull()
    expect(oldLoginSentence({ ...stale, loginAt: null })).toBeNull()
  })

  it('draws nothing before the main process has answered', () => {
    expect(renderToStaticMarkup(<TerminalSessionNotice />)).toBe('')
  })

  it('is mounted by the app, beside the moved-door card', () => {
    expect(readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')).toMatch(/<DoorMovedNotice \/>\s*\{[^}]*\}\s*<TerminalSessionNotice \/>/)
  })
})
