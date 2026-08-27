import { describe, expect, it } from 'vitest'
import { servedTurnReply } from '../src/main/served-turn-reply'
import type { TurnRecord } from '../src/shared/turn'

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  index: 1,
  prompt: 'Reply with exactly: CREW LINE OK',
  reply: 'CREW LINE OK',
  startedAt: 100,
  endedAt: 200,
  final: true,
  ...over
})

describe('served replies come from completed harness turns', () => {
  it('returns the final assistant text, never the cold PTY boot buffer', async () => {
    let history: TurnRecord[] = []
    const reply = await servedTurnReply(
      {
        history: () => history,
        deliver: async () =>
          '\u001b[200~Reply with exactly: CREW LINE OK\u001b[201~\nWelcome to Claude Code',
        wait: async () => {
          history = [record()]
        },
        now: () => 0
      },
      'Reply with exactly: CREW LINE OK'
    )

    expect(reply).toBe('CREW LINE OK')
    expect(reply).not.toContain('Welcome to Claude Code')
    expect(reply).not.toContain('\u001b[200~')
  })

  it('does not accept assistant text until the harness marks the turn final', async () => {
    let polls = 0
    let history: TurnRecord[] = []
    const reply = await servedTurnReply(
      {
        history: () => history,
        deliver: async () => '',
        wait: async () => {
          polls += 1
          history = [record({ reply: polls === 1 ? 'tool prelude' : 'the final answer', final: polls > 1 })]
        },
        now: () => 0
      },
      'Reply with exactly: CREW LINE OK'
    )

    expect(polls).toBe(2)
    expect(reply).toBe('the final answer')
  })

  it('ignores a pre-existing identical prompt and returns the new exchange', async () => {
    const old = record({ uuid: 'old-turn', reply: 'old answer' })
    let history: TurnRecord[] = [old]
    const reply = await servedTurnReply(
      {
        history: () => history,
        deliver: async () => '',
        wait: async () => {
          history = [old, record({ index: 2, uuid: 'new-turn', reply: 'new answer' })]
        },
        now: () => 0
      },
      'Reply with exactly: CREW LINE OK'
    )

    expect(reply).toBe('new answer')
  })

  it('refuses to substitute a PTY diff when no file-final turn appears', async () => {
    let now = 0
    await expect(
      servedTurnReply(
        {
          history: () => [],
          deliver: async () => 'Welcome to Claude Code',
          wait: async (ms) => {
            now += ms
          },
          now: () => now
        },
        'Reply with exactly: CREW LINE OK',
        { finalityTimeoutMs: 2, pollMs: 1 }
      )
    ).rejects.toThrow('no file-backed agent turn')
  })
})
