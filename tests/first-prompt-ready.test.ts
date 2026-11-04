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

  // A brand-new Claude opens on its theme picker, then sign-in (seen on 2.1.316):
  // no composer for minutes. Typed at the boot ceiling, the words vanish and
  // their Enter takes the picker's default, so a person's first task is lost.
  it('a first task waits past the boot ceiling for a person still signing in', async () => {
    vi.useFakeTimers()
    submitted.length = 0
    const screens = [...Array(200).fill('Choose the text style that looks best with your terminal'), COMPOSER]
    const done = injectWhenReady(session('claude', screens), 'first task', { timeoutMs: 120_000, onlyWhenReady: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(submitted).toEqual([])
    await vi.advanceTimersByTimeAsync(40_000)
    await done
    expect(submitted).toEqual(['first task\r'])
    vi.useRealTimers()
  })

  it('a first task is never typed into a screen that did not become ready', async () => {
    vi.useFakeTimers()
    submitted.length = 0
    const done = injectWhenReady(session('claude', ['Choose the text style']), 'first task', { timeoutMs: 1_000, onlyWhenReady: true })
    const failed = expect(done).rejects.toThrow(/never took/)
    await vi.advanceTimersByTimeAsync(1_500)
    await failed
    expect(submitted).toEqual([])
    vi.useRealTimers()
  })

  it('every other prompt keeps its ceiling, and goes in at it', async () => {
    vi.useFakeTimers()
    submitted.length = 0
    const done = injectWhenReady(session('claude', ['still booting']), 'a fork preamble')
    await vi.advanceTimersByTimeAsync(26_000)
    await done
    expect(submitted).toEqual(['a fork preamble\r'])
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

// One readiness predicate for a fresh pane: the fork preamble and the recruit
// brief (recruit-delivery.ts) both wait on it rather than on a fixed sleep.
describe('harnessReadyForInput', () => {
  const pane = (command: string, idle: number, screen: string) => ({ command, idleFor: () => idle, viewportText: () => screen })

  it('a pane that has painted nothing yet is not ready', async () => {
    const { harnessReadyForInput } = await import('../src/main/fork')
    expect(harnessReadyForInput(pane('claude', Number.POSITIVE_INFINITY, COMPOSER))).toBe(false)
  })

  it('a Claude pane needs quiet AND its composer — the banner alone or a busy repaint is not ready', async () => {
    const { harnessReadyForInput } = await import('../src/main/fork')
    expect(harnessReadyForInput(pane('claude', 10_000, ' ▐▛███▜▌   Claude Code v2.9'))).toBe(false)
    expect(harnessReadyForInput(pane('claude', 200, COMPOSER))).toBe(false)
    expect(harnessReadyForInput(pane('claude --model opus', 10_000, COMPOSER))).toBe(true)
  })

  it('another harness is ready once its boot output goes quiet; the node command can stand in for the session’s', async () => {
    const { harnessReadyForInput } = await import('../src/main/fork')
    expect(harnessReadyForInput(pane('codex', 10_000, '> '))).toBe(true)
    expect(harnessReadyForInput({ ...pane('', 10_000, ''), command: '' }, 'claude')).toBe(false)
  })
})
