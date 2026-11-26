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
const { CODEX_CLEAR, LINE_MAX, QUIET_MS, endLine, keysFor, lineTextFor, noteLineAgents, observeLine, resetLinesForTests, submitLine, typeLine } = await import(
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

// Owner 2026-11-16 (Codex, phone): a long Chinese message with a screenshot
// reached Codex as "5 /Users/…/Screenshot_….jpg". The picture's path was on
// the line; Codex folds a path that arrives as one burst into ONE [Image #1]
// element, so each later edit's Backspaces over the path (71 by our count)
// took the element with the first and the owner's words with the rest.
describe('a picture in the draft', () => {
  const pic = '/Users/drej/.cookrew/attachments/Screenshot_20261116_231745_Chrome.jpg'

  it('is not typed into the line while the words are written', () => {
    typeLine('a1', '输入被截断了')
    typeLine('a1', `输入被截断了 ${pic}`)
    typeLine('a1', `输入被截断了，然后 ${pic}`)
    expect(typedKeys()).toEqual(['输入被截断了', '，然后'])
    expect(typedKeys().join('')).not.toContain('\x7f')
  })

  it('goes with Enter, last, after every word', () => {
    typeLine('a1', `输入被截断了 ${pic}`)
    typeLine('a1', `输入被截断了，修复 ${pic}`)
    submitLine('a1', `输入被截断了，修复 ${pic}`)
    expect(typedKeys()).toEqual(['输入被截断了', '，修复', ` ${pic}`, '\r'])
  })

  it('stays in the draft when the words come back from LIVE', () => {
    setDraft(draftKey('a1'), `fix ${pic}`)
    observeLine('a1', activity({ pendingInput: 'fix' }), 0)
    observeLine('a1', activity({ pendingInput: 'fix it' }), 10_000)
    expect(getDraft(draftKey('a1'))).toBe(`fix it ${pic}`)
  })

  it('goes with the words when the line is emptied in LIVE (Enter or a clear there)', () => {
    setDraft(draftKey('a1'), `fix ${pic}`)
    observeLine('a1', activity({ pendingInput: 'fix' }), 0)
    observeLine('a1', activity({ pendingInput: null }), 10_000)
    expect(getDraft(draftKey('a1'))).toBe('')
  })
})

// Owner 2026-11-17: Codex input is still cut off, fix it at the root. Every send that backs over
// what this app BELIEVES is on Codex's line breaks the moment the belief is
// wrong (a folded picture, words typed or the cursor moved in LIVE, keys lost):
// Backspaces counted from the belief eat the owner's words. A Codex send no
// longer trusts the belief: it clears the whole box, then pastes the words and
// each picture whole (measured on codex 0.169, idle and mid-turn).
describe('a send to a Codex agent rebuilds its line', () => {
  const PO = '\x1b[200~'
  const PC = '\x1b[201~'
  const pic = '/Users/drej/.cookrew/attachments/Screenshot_20261117_201900_Chrome.jpg'
  const codex = (id = 'a1') => noteLineAgents([{ id, rebuild: true }])

  it('clears the box, pastes the words, then each picture on its own, then Enter', () => {
    codex()
    typeLine('a1', '可以抽出统一组件')
    ptyInput.mockReset()
    submitLine('a1', `图中圈出部分替换成agents group风格 可以抽出统一组件 ${pic}`)
    expect(typedKeys()).toEqual([`${CODEX_CLEAR}${PO}图中圈出部分替换成agents group风格 可以抽出统一组件${PC} ${PO}${pic}${PC}`, '\r'])
  })

  it('whatever it believes the line holds: the box is cleared whole', () => {
    codex()
    typeLine('a1', 'abc')
    ptyInput.mockReset()
    submitLine('a1', 'abc')
    expect(typedKeys()).toEqual([`${CODEX_CLEAR}${PO}abc${PC}`, '\r'])
  })

  it('a picture alone still goes, and a bare Enter is only an Enter', () => {
    codex()
    submitLine('a1', pic)
    submitLine('a1', '')
    expect(typedKeys()).toEqual([`${CODEX_CLEAR}${PO}${pic}${PC}`, '\r', '\r'])
  })

  it('an agent named by one source stays as another left it', () => {
    codex()
    noteLineAgents([{ id: 'b2', rebuild: false }])
    submitLine('a1', 'x')
    expect(typedKeys()).toEqual([`${CODEX_CLEAR}${PO}x${PC}`, '\r'])
  })

  it('the clear kills to the start, past the end, and across lines, with keys that never interrupt', () => {
    expect(CODEX_CLEAR.startsWith('\x15\x0b')).toBe(true)
    expect(CODEX_CLEAR).toContain('\x7f\x15')
    expect(CODEX_CLEAR).not.toMatch(/[\x03\x1b\r\n]/)
  })

  it('leaves the line empty and the draft too', () => {
    codex()
    setDraft(draftKey('a1'), 'go')
    submitLine('a1', 'go')
    ptyInput.mockReset()
    typeLine('a1', 'next')
    expect(typedKeys()).toEqual(['next'])
    expect(getDraft(draftKey('a1'))).toBe('')
  })

  it('other agents keep their typed line, and a card that stops being Codex does too', () => {
    codex()
    noteLineAgents([{ id: 'a1', rebuild: false }])
    typeLine('a1', 'hello')
    submitLine('a1', 'hello there')
    expect(typedKeys()).toEqual(['hello', ' there', '\r'])
  })
})
