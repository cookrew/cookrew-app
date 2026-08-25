import { describe, expect, it } from 'vitest'
import { isNoisePrompt, parseSessionTurns } from '../src/shared/session-turns'

// ---- fixture builders: realistic Claude Code session JSONL lines ----

function user(content: unknown, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: ts,
    sessionId: 'src-session',
    ...extra
  })
}

function assistant(blocks: unknown[], ts: string, stopReason: string | null = null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: blocks, stop_reason: stopReason },
    timestamp: ts,
    sessionId: 'src-session'
  })
}

const text = (t: string): { type: string; text: string } => ({ type: 'text', text: t })
const toolUse = (): { type: string; name: string } => ({ type: 'tool_use', name: 'Bash' })
const toolResult = (): unknown[] => [{ type: 'tool_result', content: 'ok' }]
const image = (): { type: string } => ({ type: 'image' })

describe('parseSessionTurns — image prompts & sibling collapse', () => {
  it('collapses same-parentUuid siblings (string + text+image) into ONE checkpoint bound to the continuing sibling', () => {
    // One submission Claude wrote as two user records sharing a parentUuid:
    // a plain-string mirror, then the richer text+image record the thread
    // continues from. Must mint ONE turn bound to the LAST/richer sibling.
    const turns = parseSessionTurns([
      user('well-done, check-points show full history', T('00:00'), {
        uuid: 'a8a2344e',
        parentUuid: 'eec433aa'
      }),
      user([text('well-done, check-points show full history'), image()], T('00:01'), {
        uuid: 'be7453eb',
        parentUuid: 'eec433aa'
      }),
      assistant([text('yep')], T('00:05'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].uuid).toBe('be7453eb')
    expect(turns[0].prompt).toBe('well-done, check-points show full history')
    expect(turns[0].reply).toBe('yep')
  })

  it('mints a checkpoint for an image-only submission (text+image array, no string sibling)', () => {
    const turns = parseSessionTurns([
      user([text('describe this screenshot'), image()], T('00:00'), {
        uuid: 'u-img',
        parentUuid: 'p1'
      }),
      assistant([text('a cat')], T('00:02'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('describe this screenshot')
    expect(turns[0].uuid).toBe('u-img')
  })

  it('collapses a 3-sibling branch group to the live continuation (edits/resends)', () => {
    // Same parentUuid, DIFFERENT texts: a correction/refine sequence where
    // only the last is on the live thread (verified against real sessions —
    // the last sibling is the one downstream records descend from). The
    // superseded branches are not separate checkpoints.
    const turns = parseSessionTurns([
      user('report to Constructor', T('00:00'), { uuid: 'ua', parentUuid: 'p' }),
      user('report to Conductor', T('00:01'), { uuid: 'ub', parentUuid: 'p' }),
      user('report to Conductor to analyze', T('00:02'), { uuid: 'uc', parentUuid: 'p' }),
      assistant([text('on it')], T('00:05'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].uuid).toBe('uc')
    expect(turns[0].prompt).toBe('report to Conductor to analyze')
  })

  it('does NOT collapse two distinct submissions with different parentUuids', () => {
    const turns = parseSessionTurns([
      user('first', T('00:00'), { uuid: 'u1', parentUuid: 'pa' }),
      assistant([text('r1')], T('00:05')),
      user('second', T('01:00'), { uuid: 'u2', parentUuid: 'pb' })
    ])
    expect(turns.map((t) => t.prompt)).toEqual(['first', 'second'])
  })

  it('does NOT collapse legitimate rapid duplicates (same text, different parentUuids)', () => {
    const turns = parseSessionTurns([
      user('push', T('00:00'), { uuid: 'u1', parentUuid: 'pa' }),
      assistant([text('done')], T('00:05')),
      user('push', T('01:00'), { uuid: 'u2', parentUuid: 'pb' })
    ])
    expect(turns).toHaveLength(2)
  })

  it('still skips a tool-result array (no text block) as a non-prompt', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00'), { uuid: 'u1', parentUuid: 'pa' }),
      user(toolResult(), T('00:02'), { uuid: 'tr', parentUuid: 'u1' }),
      assistant([text('done')], T('00:05'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('do it')
  })
})

const T = (s: string): string => `2026-07-20T10:${s}.000Z`
const ms = (s: string): number => Date.parse(T(s))

const TWO_TURNS = [
  user('fix the bug', T('00:00')),
  assistant([text('Looking now.')], T('00:05')),
  assistant([toolUse()], T('00:10')),
  user(toolResult(), T('00:12')),
  assistant([text('Fixed it in pty.ts.')], T('00:20')),
  user('now add a test', T('01:00')),
  assistant([text('Test added, all green.')], T('01:30'))
]

describe('parseSessionTurns', () => {
  it('derives one record per real user prompt with exact text and timestamps', () => {
    const turns = parseSessionTurns(TWO_TURNS)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({
      index: 1,
      prompt: 'fix the bug',
      reply: 'Fixed it in pty.ts.',
      // These fixture entries carry no uuid, so the identity is derived —
      // the same one parseClaudeTrace mints for the block.
      uuid: expect.stringMatching(/^claude-1-[0-9a-f]{8}$/) as unknown as string,
      startedAt: ms('00:00'),
      endedAt: ms('00:20'),
      // A later user prompt exists — positive next-user-boundary finality.
      final: true
    })
    expect(turns[1].index).toBe(2)
    expect(turns[1].prompt).toBe('now add a test')
    expect(turns[1].reply).toBe('Test added, all green.')
    expect(turns[1].startedAt).toBe(ms('01:00'))
    expect(turns[1].endedAt).toBe(ms('01:30'))
  })

  it('does not start turns on tool results, meta records or command noise', () => {
    const turns = parseSessionTurns([
      user('<command-name>/clear</command-name>', T('00:00')),
      user('Caveat: The messages below were generated locally.', T('00:01'), { isMeta: true }),
      user('real prompt', T('00:02')),
      user(toolResult(), T('00:03')),
      user('[Request interrupted by user]', T('00:04')),
      assistant([text('done')], T('00:05'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('real prompt')
  })

  it('keeps the LAST assistant text as the reply', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00')),
      assistant([text('starting')], T('00:01')),
      assistant([text('finished for real')], T('00:02'))
    ])
    expect(turns[0].reply).toBe('finished for real')
  })

  it('ignores assistant records before any prompt and skips malformed lines', () => {
    const turns = parseSessionTurns([
      assistant([text('orphan')], T('00:00')),
      'not json at all',
      '',
      user('hello', T('00:01'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].reply).toBe('')
  })

  it('shrinks with the file — parsing a truncated (rewound) session drops turns', () => {
    const full = parseSessionTurns(TWO_TURNS)
    const rewound = parseSessionTurns(TWO_TURNS.slice(0, 5))
    expect(full).toHaveLength(2)
    expect(rewound).toHaveLength(1)
    expect(rewound[0].prompt).toBe('fix the bug')
  })

  it('binds each turn to its prompt entry uuid', () => {
    const turns = parseSessionTurns([
      user('first', T('00:00'), { uuid: 'uuid-a' }),
      assistant([text('r1')], T('00:05')),
      user('second', T('01:00'), { uuid: 'uuid-b' })
    ])
    expect(turns.map((t) => t.uuid)).toEqual(['uuid-a', 'uuid-b'])
  })

  it('binds to the PROMPT uuid, never a tool-result or assistant uuid', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00'), { uuid: 'prompt-uuid' }),
      assistant([toolUse()], T('00:05')),
      user(toolResult(), T('00:06')),
      assistant([text('done')], T('00:10'))
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].uuid).toBe('prompt-uuid')
  })

  // Legacy session files predate the uuid field. The record still needs an
  // identity to join the trace block on, and it must be the SAME derived
  // identity the trace parser mints — a uuid-less record pairs with nothing
  // and shows up as a phantom rail row (see tests/checkpoint-identity.test.ts).
  it('derives the ordinal identity when the prompt entry has no uuid', () => {
    const turns = parseSessionTurns([user('no uuid here', T('00:00'))])
    expect(turns[0].uuid).toMatch(/^claude-1-[0-9a-f]{8}$/)
  })
})

// Sol P0: a nonempty reply is NOT completion evidence — parseSessionTurns
// used to install the latest assistant text immediately and keep extending
// the same record with later tool/result entries. `final` now requires
// POSITIVE evidence: a later user prompt, or the closing assistant entry's
// explicit stop_reason "end_turn" (verified against real session files —
// mid-turn entries carry "tool_use"/null).
describe('parseSessionTurns — turn finality evidence', () => {
  it('marks every non-tail record final (a later user prompt exists)', () => {
    const turns = parseSessionTurns(TWO_TURNS)
    expect(turns[0].final).toBe(true)
  })

  it('leaves the tail non-final without a stop_reason marker (legacy files)', () => {
    const turns = parseSessionTurns(TWO_TURNS)
    expect(turns[1].final).toBeUndefined()
  })

  it('marks the tail final when its closing assistant entry carries stop_reason end_turn', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00')),
      assistant([toolUse()], T('00:05'), 'tool_use'),
      user(toolResult(), T('00:06')),
      assistant([text('done')], T('00:10'), 'end_turn')
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].final).toBe(true)
  })

  it('a nonempty reply followed by a tool call is NOT final (the Sol trap)', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00')),
      assistant([text('Looks done, verifying…')], T('00:05'), 'tool_use'),
      assistant([toolUse()], T('00:06'), 'tool_use')
    ])
    expect(turns[0].reply).toBe('Looks done, verifying…')
    expect(turns[0].final).toBeUndefined()
  })

  it('finality tracks the LATEST assistant entry — end_turn then more work reopens', () => {
    const turns = parseSessionTurns([
      user('do it', T('00:00')),
      assistant([text('done')], T('00:05'), 'end_turn'),
      assistant([toolUse()], T('00:10'), 'tool_use')
    ])
    expect(turns[0].final).toBeUndefined()
  })

  it('a sibling resend reopens a finalized exchange (edit/resend chains)', () => {
    const turns = parseSessionTurns([
      user('first wording', T('00:00'), { uuid: 'ua', parentUuid: 'p' }),
      assistant([text('done')], T('00:05'), 'end_turn'),
      user('second wording', T('00:10'), { uuid: 'ub', parentUuid: 'p' })
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).toBe('second wording')
    expect(turns[0].final).toBeUndefined()
  })

  it('a prompt with no reply at all is non-final until the next prompt lands', () => {
    const open = parseSessionTurns([user('do it', T('00:00'))])
    expect(open[0].final).toBeUndefined()
    const bounded = parseSessionTurns([user('do it', T('00:00')), user('next', T('01:00'))])
    expect(bounded[0].final).toBe(true)
    expect(bounded[1].final).toBeUndefined()
  })
})

describe('isNoisePrompt', () => {
  it('flags slash-command wrappers and interruptions', () => {
    expect(isNoisePrompt('<command-name>/usage</command-name>')).toBe(true)
    expect(isNoisePrompt('<local-command-stdout>ok</local-command-stdout>')).toBe(true)
    expect(isNoisePrompt('[Request interrupted by user]')).toBe(true)
    expect(isNoisePrompt('Caveat: The messages below were generated…')).toBe(true)
  })

  it('passes real prompts through', () => {
    expect(isNoisePrompt('fix the <weird> bug')).toBe(false)
  })
})
