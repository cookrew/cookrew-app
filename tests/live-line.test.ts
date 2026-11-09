// THE DRAFT IS THE AGENT'S OWN INPUT LINE (owner, 2026-11-01: the prompt box
// "同步 LIVE"): what is typed in the box (or the card's reply box) is typed
// into the agent's terminal as it is written, and what is typed in LIVE
// comes back into the box.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalActivity } from '../src/shared/turn'

const ptyInput = vi.fn()
vi.mock('../src/renderer/src/api', () => ({ cookrew: () => ({ ptyInput }) }))

const { activityStore } = await import('../src/renderer/src/activity-thumb-store')
const { draftKey, getDraft, setDraft } = await import('../src/renderer/src/prompt/prompt-draft')
const { LINE_MAX, QUIET_MS, endLine, keysFor, lineTextFor, observeLine, resetLinesForTests, submitLine, typeLine } = await import(
  '../src/renderer/src/prompt/live-line'
)

const activity = (over: Partial<TerminalActivity> = {}): TerminalActivity =>
  ({ terminalId: 'a1', agent: true, phase: 'idle', prompt: null, pendingInput: null, lines: [], reply: null, glance: null, title: null, turnCount: 0, turnStartLine: null, ...over }) as TerminalActivity

const typedKeys = (): string[] => ptyInput.mock.calls.map((call) => call[1] as string)

beforeEach(() => {
  ptyInput.mockReset()
  resetLinesForTests()
  activityStore.set('a1', activity())
  setDraft(draftKey('a1'), '')
})

describe('keys the Mac refused', () => {
  it('never reached the line: the next send types the words again', async () => {
    const { inputRefused } = await import('../src/renderer/src/prompt/input-refused')
    typeLine('a1', 'hello')
    inputRefused.emit('a1', 'hello')
    ptyInput.mockReset()
    submitLine('a1', 'hello')
    expect(typedKeys()).toEqual(['hello', '\r'])
  })
})

// Measured 2026-11-05: Claude folds a long paste into one [Pasted text] token,
// and a single Backspace takes the whole token. The box would still hold 1499
// characters, and Enter send nothing.
describe('a draft too long for the agent\'s line', () => {
  const long = 'x'.repeat(LINE_MAX + 1)
  it('waits in the draft: nothing of it reaches the line', () => {
    typeLine('a1', long)
    expect(typedKeys()).toEqual([])
  })
  it('goes whole with Enter, in one write', () => {
    typeLine('a1', long)
    submitLine('a1', long)
    expect(typedKeys()).toEqual([long, '\r'])
  })
  it('an edit in the box stays in the box until then', () => {
    typeLine('a1', long)
    typeLine('a1', long.slice(0, -1))
    submitLine('a1', long.slice(0, -1))
    expect(typedKeys()).toEqual([long.slice(0, -1), '\r'])
  })
  it('what was typed before it stays on the line, and the rest follows', () => {
    typeLine('a1', 'hello ')
    typeLine('a1', `hello ${long}`)
    submitLine('a1', `hello ${long}`)
    expect(typedKeys()).toEqual(['hello ', long, '\r'])
  })
  it('counts bytes: Chinese fills the line sooner', () => {
    typeLine('a1', '中'.repeat(LINE_MAX / 2))
    expect(typedKeys()).toEqual([])
  })
  const later = (): number => Date.now() + QUIET_MS + 1
  const words = 'y'.repeat(LINE_MAX + 1)
  it('a key typed in LIVE does not replace a draft that waits in the box', () => {
    setDraft(draftKey('a1'), words)
    typeLine('a1', words)
    observeLine('a1', activity({ pendingInput: 'x' }), later())
    expect(getDraft(draftKey('a1'))).toBe(words)
  })
  it('nor does Enter in the terminal on the part that was on the line', () => {
    typeLine('a1', 'hello')
    observeLine('a1', activity({ pendingInput: 'hello' }), later())
    setDraft(draftKey('a1'), `hello${words}`)
    typeLine('a1', `hello${words}`)
    observeLine('a1', activity({ pendingInput: '' }), later())
    expect(getDraft(draftKey('a1'))).toBe(`hello${words}`)
  })
  it('a long paste in LIVE comes back to the box, and its Enter clears it, as ever', () => {
    observeLine('a1', activity({ pendingInput: '' }), later())
    observeLine('a1', activity({ pendingInput: words }), later())
    expect(getDraft(draftKey('a1'))).toBe(words)
    observeLine('a1', activity({ pendingInput: '' }), later())
    expect(getDraft(draftKey('a1'))).toBe('')
  })
  const pastedInLive = (): void => {
    observeLine('a1', activity({ pendingInput: '' }), later())
    observeLine('a1', activity({ pendingInput: words }), later())
  }
  it('a line that may be folded is cleared and sent again: one Backspace would take it all', () => {
    pastedInLive()
    const edited = words.slice(0, -1)
    typeLine('a1', edited)
    submitLine('a1', edited)
    expect(typedKeys()).toEqual(['\x7f'.repeat(words.length + 16) + edited, '\r'])
  })
  it('words added after it just follow it', () => {
    pastedInLive()
    typeLine('a1', `${words} more`)
    submitLine('a1', `${words} more`)
    expect(typedKeys()).toEqual([' more', '\r'])
  })
  it('cut back under the limit it syncs again', () => {
    typeLine('a1', long)
    typeLine('a1', 'short')
    expect(typedKeys()).toEqual(['short'])
  })
})

describe('keysFor', () => {
  it('types only what was added', () => {
    expect(keysFor('', 'fix')).toBe('fix')
    expect(keysFor('fix', 'fix it')).toBe(' it')
  })

  it('backs over what was removed or changed, then types the rest', () => {
    expect(keysFor('fix it', 'fix')).toBe('\x7f\x7f\x7f')
    expect(keysFor('hello world', 'hellX world')).toBe('\x7f'.repeat(7) + 'X world')
    expect(keysFor('same', 'same')).toBe('')
  })

  it('counts a Chinese word or an emoji as the characters the terminal deletes', () => {
    expect(keysFor('修好登录', '修好')).toBe('\x7f\x7f')
    expect(keysFor('ok 👍', 'ok')).toBe('\x7f\x7f')
  })
})

describe('lineTextFor', () => {
  const names = [{ id: 'f1', name: 'Forge' }, { id: 'f2', name: 'Fresco' }, { id: 'a1', name: 'Probe6' }]
  it('a plain draft is the line', () => {
    expect(lineTextFor('fix the bug', 'a1', null, names)).toBe('fix the bug')
  })

  it('"@Other …" puts nothing in this agent\'s line; "@Self …" only the words', () => {
    expect(lineTextFor('@Forge hi', 'a1', { id: 'f1', text: 'hi' }, names)).toBe('')
    expect(lineTextFor('@Probe6 hi', 'a1', { id: 'a1', text: 'hi' }, names)).toBe('hi')
  })

  it('an "@" still naming an agent waits; a file mention does not', () => {
    expect(lineTextFor('@F', 'a1', null, names)).toBe('')
    expect(lineTextFor('@fre', 'a1', null, names)).toBe('')
    expect(lineTextFor('@src/main.ts', 'a1', null, names)).toBe('@src/main.ts')
  })

  it('a teammate named among the words goes in as the command that asks them', () => {
    expect(lineTextFor('check with @Forge first', 'a1', null, names)).toBe('check with cookrew ask "Forge" first')
    expect(lineTextFor('check with @For', 'a1', null, names)).toBe('check with ')
    // Itself is no teammate: its own name stays as it was typed.
    expect(lineTextFor('you are @Probe6', 'a1', null, names)).toBe('you are @Probe6')
  })
})

describe('the box types into the agent line', () => {
  it('each edit sends only its difference', () => {
    typeLine('a1', 'fi')
    typeLine('a1', 'fix')
    typeLine('a1', 'fi')
    expect(typedKeys()).toEqual(['fi', 'x', '\x7f'])
  })

  it('starts from what the agent line already holds', () => {
    activityStore.set('a1', activity({ pendingInput: 'look at' }))
    typeLine('a1', 'look at this')
    expect(typedKeys()).toEqual([' this'])
  })

  it('holds back while the agent asks a question, and catches up after', () => {
    typeLine('a1', 'fix')
    activityStore.set('a1', activity({ phase: 'waiting' }))
    typeLine('a1', 'fix it')
    expect(typedKeys()).toEqual(['fix'])
    activityStore.set('a1', activity({ phase: 'idle' }))
    typeLine('a1', 'fix it!')
    expect(typedKeys()).toEqual(['fix', ' it!'])
  })

  it('Enter submits the line as written, even past a question', () => {
    typeLine('a1', 'yes')
    activityStore.set('a1', activity({ phase: 'waiting' }))
    typeLine('a1', 'yes please')
    submitLine('a1', 'yes please')
    expect(typedKeys()).toEqual(['yes', ' please', '\r'])
  })

  it('after Enter the line and the draft are empty', () => {
    setDraft(draftKey('a1'), 'go')
    typeLine('a1', 'go')
    submitLine('a1', 'go')
    expect(getDraft(draftKey('a1'))).toBe('')
    typeLine('a1', 'next')
    expect(typedKeys()).toEqual(['go', '\r', 'next'])
  })

  it('a bare Enter types nothing first', () => {
    submitLine('a1', '')
    expect(typedKeys()).toEqual(['\r'])
  })

  it('a line submitted by other means starts empty again', () => {
    typeLine('a1', 'half')
    endLine('a1')
    typeLine('a1', 'new')
    expect(typedKeys()).toEqual(['half', 'new'])
  })
})

describe('words typed in LIVE come back into the draft', () => {
  it('takes the line the tracker reads, once this box has been quiet', () => {
    observeLine('a1', activity(), 0)
    observeLine('a1', activity({ pendingInput: 'typed in LIVE' }), 10_000)
    expect(getDraft(draftKey('a1'))).toBe('typed in LIVE')
    // …and the next edit here starts from it.
    typeLine('a1', 'typed in LIVE!')
    expect(typedKeys()).toEqual(['!'])
  })

  it('a first reading fills an empty draft, never one already written', () => {
    observeLine('a1', activity({ pendingInput: 'from before' }), 0)
    expect(getDraft(draftKey('a1'))).toBe('from before')
    resetLinesForTests()
    setDraft(draftKey('a1'), 'mine')
    observeLine('a1', activity({ pendingInput: 'theirs' }), 0)
    expect(getDraft(draftKey('a1'))).toBe('mine')
  })

  it('a late reading of this box own keys does not undo newer typing', () => {
    setDraft(draftKey('a1'), 'fix it')
    typeLine('a1', 'fix it')
    observeLine('a1', activity({ pendingInput: 'fix' }), Date.now())
    expect(getDraft(draftKey('a1'))).toBe('fix it')
  })

  it('a reading equal to what was typed here (less its trailing space) changes nothing', () => {
    setDraft(draftKey('a1'), 'fix ')
    typeLine('a1', 'fix ')
    observeLine('a1', activity({ pendingInput: 'fix' }), Date.now() + QUIET_MS * 2)
    expect(getDraft(draftKey('a1'))).toBe('fix ')
  })

  it('a reading that never moves never wipes a draft', () => {
    observeLine('a1', activity(), 0)
    setDraft(draftKey('a1'), 'kept')
    typeLine('a1', 'kept')
    observeLine('a1', activity(), Date.now() + QUIET_MS * 2)
    expect(getDraft(draftKey('a1'))).toBe('kept')
  })

  it('a submit seen in LIVE empties the draft', () => {
    observeLine('a1', activity(), 0)
    observeLine('a1', activity({ pendingInput: 'go' }), 10_000)
    observeLine('a1', activity({ pendingInput: null }), 20_000)
    expect(getDraft(draftKey('a1'))).toBe('')
  })

  it("a multiplexer's guess (no screen) is not a reading", () => {
    observeLine('a1', activity(), 0)
    observeLine('a1', activity({ pendingInput: 'guess', mirrorless: true }), 10_000)
    expect(getDraft(draftKey('a1'))).toBe('')
  })
})
