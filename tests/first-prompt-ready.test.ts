// A prompt typed into a Claude pane before Claude reads its input loses its
// first characters ("gent prompt inputbox…", 2026-11-01): the injection waits
// for the composer to be drawn, not only for the boot output to go quiet.
import { describe, expect, it, vi } from 'vitest'

const submitted: string[] = []
vi.mock('../src/main/ask', () => ({ ownerSubmit: async (_s: unknown, bytes: string) => (submitted.push(bytes), { ok: true, submitted: true }) }))
const { claudeComposerDrawn, injectWhenReady } = await import('../src/main/fork')

const COMPOSER = ['', '────────────────────────────────', '❯ ', '────────────────────────────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

describe('claudeComposerDrawn', () => {
  it('sees the input box between its rules, or the hint line under it', () => {
    expect(claudeComposerDrawn(COMPOSER)).toBe(true)
    expect(claudeComposerDrawn('────────────────\n❯ \n────────────────')).toBe(true)
    expect(claudeComposerDrawn('  ? for shortcuts')).toBe(true)
  })

  it('a shell prompt, a clear screen or the boot banner is not it', () => {
    expect(claudeComposerDrawn('➜  cookrew-dev git:(dev) clear; exec claude')).toBe(false)
    expect(claudeComposerDrawn('')).toBe(false)
    expect(claudeComposerDrawn(' ▐▛███▜▌   Claude Code v2.9\n▝▜█████▛▘  Opus 5.5')).toBe(false)
  })
})

describe('injectWhenReady', () => {
  const session = (command: string, screens: string[]) => {
    let reads = 0
    return {
      command,
      idleFor: () => 10_000,
      viewportText: () => screens[Math.min(reads++, screens.length - 1)]
    } as never
  }

  it('a Claude pane quiet but not yet drawn waits for its composer', async () => {
    vi.useFakeTimers()
    submitted.length = 0
    const done = injectWhenReady(session('claude --dangerously-skip-permissions', ['', '', '', COMPOSER]), 'Agent prompt box')
    await vi.advanceTimersByTimeAsync(700)
    expect(submitted).toEqual([])
    await vi.advanceTimersByTimeAsync(900)
    await done
    expect(submitted).toEqual(['Agent prompt box\r'])
    vi.useRealTimers()
  })

  it('another harness goes on quiet alone, as before', async () => {
    vi.useFakeTimers()
    submitted.length = 0
    const done = injectWhenReady(session('codex', ['']), 'hello')
    await vi.advanceTimersByTimeAsync(400)
    await done
    expect(submitted).toEqual(['hello\r'])
    vi.useRealTimers()
  })
})
