// WHAT A WAITING AGENT ASKS TO DO (owner, 2026-11-05: "Do you want to proceed?"
// stood on the card with nothing to say what). The fixtures are real panes,
// Claude Code 2.1.316 in a private tmux server: a command taller than a 43 x 29
// phone pane, its head gone from the screen, and the same box at 120 columns.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMenuAnswerer, parseMenuRequest } from '../src/main/menu-answer'
import type { PtySession } from '../src/main/pty'
import { TurnTracker } from '../src/main/turn-tracker'
import { aboutOfScreen, briefId, wholeBrief, type WaitAbout } from '../src/shared/wait-about'
import { choiceId, choiceSig, waitChoiceOfScreen, type WaitChoice } from '../src/shared/wait-choice'

const text = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'wait-choice', `${name}.txt`), 'utf8')
const read = (screen: string): WaitChoice => {
  const choice = waitChoiceOfScreen(screen)
  if (!choice) throw new Error('no menu')
  return choice
}
const aboutOf = (name: string): WaitAbout => {
  const about = read(text(name)).about
  if (!about) throw new Error(`${name}: nothing about it`)
  return about
}

const PHONE = text('claude-bash-tall-phone')
const HISTORY = text('claude-bash-tall-phone-history')
const TARGET = '/Users/anon/.cache/wc-fix-legal/scratchpad/legal/shots/*'

describe('a box that fits the screen', () => {
  it('reads what it says it does, why it asks and the whole command, bars out', () => {
    const about = aboutOf('claude-bash-dangerous-wide')
    expect(about.title).toBe('Rebuild bundle and re-shoot pages on own ports')
    expect(about.notes[0]).toBe(`Dangerous rm operation on statically-unresolvable target: ${TARGET}`)
    expect(about.notes[1]).toContain('automatically block this request in 1:54')
    expect(about.body[0]).toBe('cd /Users/anon/.cache/wc-fix-legal')
    expect(about.body).toContain('rm -rf /tmp/wc-fix/legal-data scratchpad/legal/shots/*')
    expect(about.body.at(-1)).toBe('ls scratchpad/legal/shots | wc -l')
    expect(about.partial).toBe(false)
  })

  it('leaves the bar out of the sub too', () => {
    expect(read(text('claude-bash-dangerous-wide')).sub).toBe('Bash · cd /Users/anon/.cache/wc-fix-legal')
  })

  it('drops the tip, keeps the description', () => {
    const about = aboutOf('claude-bash')
    expect(about.title).toBe('Create d1 directory')
    expect(about.body).toEqual(['mkdir -p /tmp/wc-fix/claude/d1'])
    expect(about.notes).toEqual([])
  })

  it('reads a tip the pane wrapped, and the words Claude adds over the question', () => {
    const about = aboutOf('claude-rule-row-cursor')
    expect(about.title).toBe('Create a Cookrew note named mq-scratch-note')
    expect(about.notes).toEqual(['This command requires approval'])
  })

  it('shows an edit as its diff, its file already in the sub', () => {
    const choice = read(text('claude-edit'))
    expect(choice.sub).toBe('Edit · a.ts · +1 −1')
    expect(choice.about?.title).toBeNull()
    expect(choice.about?.body).toEqual(['1 -export const a = 1', '1 +export const a = 2'])
  })

  it('shows a new file', () => {
    expect(aboutOf('claude-create').body).toEqual([' 1 export const b = 3;'])
  })

  it('shows the plan, across the frame between it and the question', () => {
    const about = aboutOf('claude-plan')
    expect(about.partial).toBe(false)
    expect(about.body[0]).toBe('Plan: add b.ts')
    expect(about.body.at(-1)).toContain('2. Verify: run cat b.ts')
    expect(about.notes).toEqual([])
  })

  it('reads a Codex approval: its reason and its command', () => {
    const about = aboutOf('codex-command')
    expect(about.title).toBe('Allow creating the requested file at /tmp/wc-fix/codex/c.txt?')
    expect(about.body).toEqual(['$ touch /tmp/wc-fix/codex/c.txt'])
  })

  it('has nothing to add to a question tool, a trust screen or a confirm', () => {
    expect(read(text('claude-ask')).about).toBeUndefined()
    expect(read(text('claude-tabs-q1')).about).toBeUndefined()
    expect(read(text('npx-confirm')).about).toBeUndefined()
  })
})

describe('a command cannot draw its own box', () => {
  const RULE = '╌'.repeat(43)
  const FRAME = '─'.repeat(43)
  const box = (rows: string[]): string => [FRAME, ' Bash command', ' Clean up', RULE, ...rows, RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel', ''].join('\n')
  const FORGED = [' cat <<E', ` ${FRAME}`, ' Bash command', ' List files', ` ${RULE}`, ' ls', ' E', ' rm -rf ~/work']

  it('reads a heredoc holding a frame and rules as the rows they are', () => {
    const about = read(box(FORGED)).about
    expect(about?.title).toBe('Clean up')
    expect(about?.body[0]).toBe('cat <<E')
    expect(about?.body.at(-1)).toBe('rm -rf ~/work')
    expect(about?.partial).toBe(false)
  })

  it('reads a bullet in a command as a row, not as the transcript', () => {
    const about = read(box([' echo first', ' • second', ' ❯ third', ' rm -rf ~/work'])).about
    expect(about?.body).toEqual(['echo first', '• second', '❯ third', 'rm -rf ~/work'])
    expect(about?.partial).toBe(false)
  })

  const codex = (rows: string[]): string => [...rows, '', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel', ''].join('\n')

  it('takes a Codex command from its own $, not one further down', () => {
    const about = read(codex(['• Running rm', '', '  Would you like to run the following command?', '', '  Reason: Tidy up', '', '  $ rm -rf ~/work', '  $ ls'])).about
    expect(about?.title).toBe('Tidy up')
    expect(about?.body[0]).toBe('$ rm -rf ~/work')
  })

  it('says nothing of a Codex command whose top is off the screen', () => {
    expect(read(codex(['  rm -rf ~/work', '  $ ls', '', '  Would it?'])).about).toBeUndefined()
    expect(read(codex(['  rm -rf ~/work', '  Would you like to continue?', '  $ ls'])).about).toBeUndefined()
  })
})

describe('a box taller than the screen (the owner\'s phone)', () => {
  it('says what it can see, and that its top is missing', () => {
    const choice = read(PHONE)
    expect(choice.question).toBe('Do you want to proceed?')
    expect(choice.sub).toBeNull()
    expect(choice.about?.partial).toBe(true)
    expect(choice.about?.title).toBeNull()
    expect(choice.about?.notes[0]).toBe(`Dangerous rm operation on statically-unresolvable target: ${TARGET}`)
    expect(choice.about?.body.at(-1)).toBe('ls scratchpad/legal/shots | wc -l')
  })

  it('keeps a command\'s rows as the pane drew them: a guess at a broken word could hide what runs', () => {
    expect(read(PHONE).about?.body).toContain('s-well-past-the-width-of-a-phone-pane-s')
  })

  it('gets the rest from the pane\'s history', () => {
    const shown = read(PHONE)
    const whole = wholeBrief(shown, aboutOfScreen(HISTORY))
    expect(whole.about?.partial).toBe(false)
    expect(whole.about?.title).toBe('Rebuild bundle and re-shoot pages on own ports')
    expect(whole.about?.body[0]).toBe('cd /Users/anon/.cache/wc-fix-legal')
    expect(whole.about?.body.at(-1)).toBe('ls scratchpad/legal/shots | wc -l')
  })

  it('keeps the screen\'s own notes: the countdown runs on', () => {
    const later = read(PHONE.replace('1:56', '0:41'))
    expect(wholeBrief(later, aboutOfScreen(HISTORY)).about?.notes[1]).toContain('in 0:41')
  })

  it('takes the last frame of a history that holds older ones', () => {
    const older = HISTORY.replace('Rebuild bundle and re-shoot pages on own', 'An older box with the same rows at the')
    expect(wholeBrief(read(PHONE), aboutOfScreen(`${older}\n${HISTORY}`)).about?.title).toBe('Rebuild bundle and re-shoot pages on own ports')
  })

  it('never puts another box\'s command over these rows', () => {
    const other = HISTORY.replaceAll('ls scratchpad/legal/shots | wc -l', 'ls scratchpad/other/shots | wc -l')
    const shown = read(PHONE)
    expect(wholeBrief(shown, aboutOfScreen(other))).toBe(shown)
  })

  it('wants more than one row in common', () => {
    const other: WaitAbout = { title: 'Other', notes: [], body: ['rm -rf ~/work', 'done'], partial: false }
    const shown = { about: { title: null, notes: [], body: ['done'], partial: true } }
    expect(wholeBrief(shown, other)).toBe(shown)
  })

  it('stays as it is with a history that has no top either', () => {
    const shown = read(PHONE)
    expect(wholeBrief(shown, aboutOfScreen(PHONE))).toBe(shown)
    expect(wholeBrief(shown, null)).toBe(shown)
  })

  it('caps what rides each push, its head and its end kept', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ` │ echo ${i}`).join('\n')
    const box = (body: string): string => `───────────────\n Bash command\n Long one\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n${body}\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n`
    const shown = read(box(rows).split('\n').slice(300).join('\n'))
    const whole = wholeBrief(shown, aboutOfScreen(box(rows)))
    expect(whole.about?.body.length).toBeLessThanOrEqual(121)
    expect(whole.about?.body[0]).toBe('echo 0')
    expect(whole.about?.body.at(-1)).toBe('echo 399')
    expect(whole.about?.body).toContain('… 280 more lines …')
  })

  it('leaves the menu\'s identity alone: an answer is checked against the bare screen', () => {
    const shown = read(PHONE)
    const whole = wholeBrief(shown, aboutOfScreen(HISTORY))
    expect(choiceId(whole)).toBe(choiceId(shown))
    expect(choiceSig(whole)).toBe(choiceSig(shown))
    expect(choiceId(read(PHONE.replace('1:56', '0:41')))).toBe(choiceId(shown))
  })
})

describe('two tall boxes one after the other (a real pane, the first approved)', () => {
  const first = wholeBrief(read(text('claude-bash-tall-next-a')), aboutOfScreen(text('claude-bash-tall-next-a-history')))
  const second = wholeBrief(read(text('claude-bash-tall-next-b')), aboutOfScreen(text('claude-bash-tall-next-b-history')))

  it('reads each its own top: the history holds the second box whole, not the first over its rows', () => {
    expect(first.about?.title).toBe('First box AAA')
    expect(second.about?.title).toBe('Second box BBB')
    expect(second.about?.body.join('\n')).toContain('BBB-top')
    expect(second.about?.body.join('\n')).not.toContain('AAA-top')
  })

  it('are one menu to the screen, and two to an answer', () => {
    expect(choiceId(second)).toBe(choiceId(first))
    expect(briefId(second.about)).not.toBe(briefId(first.about))
  })
})

describe('an answer names what it approves', () => {
  it('a brief is the title and the body, never the countdown', () => {
    const shown = read(text('claude-bash-dangerous-wide'))
    expect(briefId(read(text('claude-bash-dangerous-wide').replace('1:54', '0:12')).about)).toBe(briefId(shown.about))
    expect(briefId(read(text('claude-bash-dangerous-wide').replaceAll('legal/shots', 'other/shots')).about)).not.toBe(briefId(shown.about))
    expect(briefId(undefined)).toBe('')
  })

  it('crosses the wire, and an old page without one still parses', () => {
    expect(parseMenuRequest({ menu: 'm', act: { kind: 'esc' }, brief: 'b' })).toEqual({ menu: 'm', act: { kind: 'esc' }, brief: 'b' })
    expect(parseMenuRequest({ menu: 'm', act: { kind: 'esc' } })).toEqual({ menu: 'm', act: { kind: 'esc' } })
    expect(parseMenuRequest({ menu: 'm', act: { kind: 'esc' }, brief: 7 })).toEqual({ menu: 'm', act: { kind: 'esc' } })
  })

  const WIDE = text('claude-bash-dangerous-wide')
  const answerer = (screen: string, whole?: (id: string, choice: WaitChoice | null) => Promise<WaitChoice | null>): { answer: ReturnType<typeof createMenuAnswerer>; sent: string[]; moved: string[] } => {
    const sent: string[] = []
    const moved: string[] = []
    const answer = createMenuAnswerer({
      screen: async () => screen,
      send: (_id, keys) => {
        sent.push(keys)
        return true
      },
      sleep: async () => undefined,
      ...(whole ? { whole } : {}),
      moved: (id) => moved.push(id)
    })
    return { answer, sent, moved }
  }

  it('refuses a Yes on a command that is not the one on the card', async () => {
    const card = read(WIDE)
    const { answer, sent, moved } = answerer(WIDE.replaceAll('wc -l', 'wc -c'))
    expect(choiceId(read(WIDE.replaceAll('wc -l', 'wc -c')))).toBe(choiceId(card))
    expect(await answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(sent).toEqual([])
    expect(moved).toEqual(['t1'])
  })

  it('takes a Yes on the command on the card', async () => {
    const card = read(WIDE)
    const { answer, sent } = answerer(WIDE.replace('1:54', '1:50'))
    expect(await answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: true })
    expect(sent).toEqual(['1'])
  })

  it('checks a tall box against the whole of it, read now', async () => {
    const card = wholeBrief(read(PHONE), aboutOfScreen(HISTORY))
    const fresh = (history: string) => async (_id: string, choice: WaitChoice | null): Promise<WaitChoice | null> => (choice ? wholeBrief(choice, aboutOfScreen(history)) : null)
    const same = answerer(PHONE, fresh(HISTORY))
    expect(await same.answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: true })
    const other = answerer(PHONE, fresh(HISTORY.replaceAll('Rebuild bundle and re-shoot pages on own', 'Wipe the home folder and all that is in')))
    expect(await other.answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(other.sent).toEqual([])
  })

  it('counts what the cap cut out: two long commands differing in a hidden row', async () => {
    const rows = (mid: string): string => Array.from({ length: 300 }, (_, i) => ` │ ${i === 150 ? mid : `echo ${i}`}`).join('\n')
    const box = (body: string): string => `───────────────\n Bash command\n Long one\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n${body}\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n`
    const tail = (body: string): string => box(body).split('\n').slice(250).join('\n')
    const card = wholeBrief(read(tail(rows('echo safe'))), aboutOfScreen(box(rows('echo safe'))))
    const { answer, sent } = answerer(tail(rows('rm -rf ~/work')), async (_id, choice) => (choice ? wholeBrief(choice, aboutOfScreen(box(rows('rm -rf ~/work')))) : null))
    expect(await answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(sent).toEqual([])
  })

  it('reads the screen again after the pane: the box can change while it answers', async () => {
    const card = wholeBrief(read(PHONE), aboutOfScreen(HISTORY))
    const screens = [PHONE, '⏺ Done.\n']
    const sent: string[] = []
    const answer = createMenuAnswerer({
      screen: async () => screens.shift() ?? null,
      send: (_id, keys) => {
        sent.push(keys)
        return true
      },
      whole: async (_id, choice) => (choice ? wholeBrief(choice, aboutOfScreen(HISTORY)) : null),
      sleep: async () => undefined
    })
    expect(await answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(sent).toEqual([])
  })

  it('takes a tap on a card that said its top was missing: it matches the screen', async () => {
    const card = read(PHONE)
    const { answer, sent } = answerer(PHONE, async () => {
      throw new Error('no read needed')
    })
    expect(await answer('t1', { menu: choiceId(card), brief: briefId(card.about), act: { kind: 'row', index: 0 } })).toEqual({ ok: true })
    expect(sent).toEqual(['1'])
  })

  it('refuses a whole card it cannot check, but never its No', async () => {
    const card = wholeBrief(read(PHONE), aboutOfScreen(HISTORY))
    const { answer, sent } = answerer(PHONE, async (_id, choice) => choice)
    const ask = { menu: choiceId(card), brief: briefId(card.about) }
    expect(await answer('t1', { ...ask, act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(await answer('t1', { ...ask, act: { kind: 'row', index: 1 } })).toEqual({ ok: true })
    expect(sent).toEqual(['2'])
  })

  it('never stands in the way of Esc, or of a page that sends no brief', async () => {
    const card = read(WIDE)
    const { answer, sent } = answerer(WIDE.replaceAll('wc -l', 'wc -c'))
    expect(await answer('t1', { menu: choiceId(card), brief: 'stale', act: { kind: 'esc' } })).toEqual({ ok: true })
    expect(await answer('t1', { menu: choiceId(card), act: { kind: 'row', index: 1 } })).toEqual({ ok: true })
    expect(sent).toEqual(['\x1b', '2'])
  })
})

describe('the tracker', () => {
  class Pane extends EventEmitter {
    text = PHONE
    constructor(public terminalId: string, public sessionName = `cookrew_${terminalId}`) {
      super()
    }
    fullText = (): string => this.text
    viewportText = (): string => this.text
    idleFor = (): number => 60_000
  }
  const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const held = (history: (id: string) => Promise<string | null>, screen = PHONE): { turns: TurnTracker; session: Pane; about: () => WaitAbout | undefined } => {
    const session = new Pane('t1')
    session.text = screen
    const turns = new TurnTracker(async () => null)
    turns.paneHistory = history
    turns.track(session as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'waiting')
    return { turns, session, about: () => turns.list().find((a) => a.terminalId === 't1')?.waitChoice?.about }
  }

  it('fills a tall box in from the pane, once', async () => {
    const asked: string[] = []
    const { about, session } = held(async (id) => {
      asked.push(id)
      return HISTORY
    })
    expect(about()?.partial).toBe(true)
    await settled()
    expect(about()?.title).toBe('Rebuild bundle and re-shoot pages on own ports')
    session.emit('data', 'tick')
    session.text = PHONE.replace('1:56', '1:55')
    session.emit('parsed')
    expect(about()?.notes[1]).toContain('in 1:55')
    expect(about()?.partial).toBe(false)
    expect(asked).toEqual(['t1'])
  })

  it('asks nothing of the pane for a box the screen holds', async () => {
    const asked: string[] = []
    const { about } = held(async (id) => {
      asked.push(id)
      return null
    }, text('claude-bash-dangerous-wide'))
    expect(about()?.partial).toBe(false)
    await settled()
    expect(asked).toEqual([])
  })

  it('does not hold an answered box\'s head for the next one', async () => {
    const { about, turns, session } = held(async () => HISTORY)
    about()
    await settled()
    expect(about()?.partial).toBe(false)
    turns.noteMenuAnswer('t1')
    session.emit('parsed')
    expect(about()?.partial).toBe(true)
  })

  it('reads again after a frame with no menu: the next box can end like the last', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let history = HISTORY
      const { about, session } = held(async () => history)
      about()
      await settled()
      expect(about()?.title).toBe('Rebuild bundle and re-shoot pages on own ports')
      session.text = '⏺ Done.\n'
      session.emit('parsed')
      history = HISTORY.replaceAll('Rebuild bundle and re-shoot pages on own', 'Wipe the home folder and all that is in')
      session.text = PHONE
      session.emit('parsed')
      vi.advanceTimersByTime(1100)
      about()
      await settled()
      expect(about()?.title).toBe('Wipe the home folder and all that is in ports')
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows a new box with the same end, with no frame between them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let history = HISTORY
      const { about, session } = held(async () => history)
      about()
      await settled()
      expect(about()?.title).toBe('Rebuild bundle and re-shoot pages on own ports')
      history = HISTORY.replaceAll('Rebuild bundle and re-shoot pages on own', 'Wipe the home folder and all that is in')
      session.emit('data', 'repaint')
      session.emit('parsed')
      about()
      vi.advanceTimersByTime(5100)
      about()
      await settled()
      expect(about()?.title).toBe('Wipe the home folder and all that is in ports')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a quiet whole box alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const asked: string[] = []
      const { about } = held(async (id) => {
        asked.push(id)
        return HISTORY
      })
      about()
      await settled()
      for (let i = 0; i < 6; i += 1) {
        about()
        vi.advanceTimersByTime(6000)
        await settled()
      }
      expect(asked.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a read a countdown tick lands during', async () => {
    let land: (text: string) => void = () => undefined
    const { about, session } = held(() => new Promise((resolve) => (land = resolve)))
    about()
    session.emit('data', 'tick')
    session.emit('parsed')
    about()
    land(HISTORY)
    await settled()
    expect(about()?.partial).toBe(false)
  })

  it('tries a quiet box again: nothing else will wake it, and it stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const asked: string[] = []
      let history: string | null = null
      const { about } = held(async (id) => {
        asked.push(id)
        return history
      })
      about()
      await settled()
      expect(about()?.partial).toBe(true)
      history = HISTORY
      vi.advanceTimersByTime(1100)
      about()
      await settled()
      expect(about()?.partial).toBe(false)
      expect(asked.length).toBe(2)

      const none: string[] = []
      const { about: never } = held(async (id) => {
        none.push(id)
        return null
      })
      for (let i = 0; i < 12; i += 1) {
        never()
        await settled()
        vi.advanceTimersByTime(1100)
      }
      expect(none.length).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads again when an answer finds the card behind', async () => {
    const asked: string[] = []
    const { about, turns } = held(async (id) => {
      asked.push(id)
      return HISTORY
    })
    about()
    await settled()
    expect(about()?.partial).toBe(false)
    turns.refreshBox('t1')
    about()
    await settled()
    expect(asked.length).toBe(2)
  })

  it('shows what the screen has when the pane cannot say', async () => {
    const { about } = held(async () => {
      throw new Error('herdr away')
    })
    about()
    await settled()
    expect(about()?.partial).toBe(true)
    expect(about()?.notes[0]).toContain('Dangerous rm')
  })
})
