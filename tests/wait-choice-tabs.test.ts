// A REAL QUESTION TOOL ON A NARROW PANE (owner, 2026-11-04, a Samsung over the
// relay: CVE-2026-98432 waited on a four-question AskUserQuestion and no rows
// showed). Its menu ran to 30 lines, so the activity's 14-line tail never held
// row 1; its question was Chinese, with no "?"; a pane once wider left text
// standing right of the frame. These fixtures are the panes as `cookrew check`
// read them, Claude Code 2.1.316, keys measured on a live probe the same day:
//   a digit picks a row and moves to the next question;
//   on "Type something" a digit puts the cursor there, words fill it, Enter takes it;
//   in a multi-select a digit toggles in place and arrows reach the words' row and Submit;
//   Tab and ← → change question; the Review tab's 1 submits.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanTurnLines, tailLines } from '../src/shared/turn'
import { answerKeys, choiceKeys, choiceSig, menuHeldOnScreen, parseWaitChoice, waitChoiceOfScreen, type WaitChoice } from '../src/shared/wait-choice'

const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'wait-choice', `${name}.txt`), 'utf8')
const read = (name: string): WaitChoice => {
  const choice = waitChoiceOfScreen(screen(name))
  if (!choice) throw new Error(`${name}: no choice`)
  return choice
}
const labels = (c: WaitChoice): string[] => c.options.map((o) => o.label)
const DOWN = '\x1b[B'

describe('the owner\'s pane: four questions, 43 columns, Chinese', () => {
  const choice = read('claude-ask-multi-narrow-zh')
  it('finds every row, row 1 included, far above a 14-line tail', () => {
    expect(labels(choice)).toEqual(['先换 EIP 再换节点 (Recommended)', '原地补齐后重启', '先加临时缓解', '暂时不动', 'Type something.', 'Chat about this'])
    expect(choice.cursor).toBe(0)
  })
  it('reads the whole question, its quote bar out and no "?" needed', () => {
    expect(choice.question).toContain('testnet3 的 dns-edge 还在跑未修复的内核')
    expect(choice.question.endsWith('怎么修？')).toBe(true)
    expect(choice.question).not.toContain('│')
  })
  it('joins a wrapped description with no space inside Chinese', () => {
    expect(choice.options[1].detail).toContain('生成 6.12.113 的 initramfs，切换默认启动项后重启。')
  })
  it('knows the words row and the chat row from the rows that pick', () => {
    expect(choice.options.map((o) => o.role ?? 'pick')).toEqual(['pick', 'pick', 'pick', 'pick', 'type', 'chat'])
  })
  it('says how far the questions have come', () => {
    expect(choice.steps).toEqual({ done: 0, total: 4 })
  })
})

describe('text left of a wider pane', () => {
  it('the rule nearest the menu sets the frame, not the most frequent one', () => {
    const old = '─'.repeat(43)
    const wide = '─'.repeat(100)
    const long = 'Yes, and do not ask again for git push commands in this project'
    const pane = [old, old, wide, ' ☐ Go', '', 'Do it?', '', `❯ 1. ${long}`, '  2. No', wide, '', 'Enter to select · Esc to cancel'].join('\n')
    expect(waitChoiceOfScreen(pane)?.options[0].label).toBe(long)
  })
  it('stands outside the frame and out of the labels', () => {
    const choice = read('claude-tabs-q1')
    expect(labels(choice)).toEqual(['先换 EIP', '原地重启', '临时缓解', '暂时不动', 'Type something.', 'Chat about this'])
    expect(choice.question).toBe('testnet3 的 dns-edge 还在跑未修复的内核，怎么修？')
    expect(choice.options[0].detail).toBe('先把 EIP 切到已修复的节点，再处理旧节点的内核。')
  })
})

describe('the next question', () => {
  it('counts what is answered', () => {
    const choice = read('claude-tabs-q2')
    expect(choice.question).toBe('Which scope should this cover?')
    expect(choice.steps).toEqual({ done: 1, total: 3 })
    expect(choice.options[0].detail).toBe('Apply to every node in the environment.')
  })
  it('keeps the words row by its place once words stand in it', () => {
    const choice = read('claude-tabs-q2-typed')
    expect(choice.options[2]).toMatchObject({ label: 'edge only please', role: 'type' })
    expect(choice.cursor).toBe(2)
  })
  it('a digit moves to the words row of a single-pick question', () => {
    expect(choiceKeys(read('claude-tabs-q2'), 2)).toBe('3')
  })
})

describe('a multi-select', () => {
  const choice = read('claude-tabs-multi')
  it('reads its ticks, the words row, an unnumbered Submit and the chat row', () => {
    expect(labels(choice)).toEqual(['Summary', 'Timeline', 'Diff', 'Type something', 'Submit', 'Chat about this'])
    expect(choice.options.map((o) => o.role ?? 'pick')).toEqual(['toggle', 'toggle', 'toggle', 'type', 'submit', 'chat'])
    expect(choice.options.slice(0, 3).map((o) => o.checked)).toEqual([true, false, true])
  })
  it('a digit toggles; arrows reach the words row and Submit; the chat row keeps its own number', () => {
    expect(choiceKeys(choice, 1)).toBe('2')
    expect(choiceKeys(choice, 3)).toBe(DOWN.repeat(3))
    expect(choiceKeys(choice, 4)).toBe(`${DOWN.repeat(4)}\r`)
    expect(choiceKeys(choice, 5)).toBe('5')
  })
  it('a tick is a new state of the menu: the box shows it at once', () => {
    const untick: WaitChoice = { ...choice, options: choice.options.map((o, i) => (i === 0 ? { ...o, checked: false } : o)) }
    expect(choiceSig(untick)).not.toBe(choiceSig(choice))
  })
})

describe('the review before it goes', () => {
  const choice = read('claude-tabs-review')
  it('asks, with the two rows, every question answered', () => {
    expect(choice.question).toBe('Ready to submit your answers?')
    expect(labels(choice)).toEqual(['Submit answers', 'Cancel'])
    expect(choice.steps).toEqual({ done: 3, total: 3 })
  })
  it('lists the answers, so what is sent is seen', () => {
    expect(choice.review).toEqual([
      { question: 'testnet3 的 dns-edge 还在跑未修复的内核，怎么修？', answer: '原地重启' },
      { question: 'Which scope should this cover?', answer: 'edge only please' },
      { question: 'Pick what to include in the report', answer: 'Summary, Diff' }
    ])
  })
})

describe('the older panes read the same off a whole screen', () => {
  it.each(['claude-edit', 'claude-bash', 'claude-plan', 'claude-ask', 'codex-command', 'npx-confirm'])('%s', (name) => {
    const old = parseWaitChoice(tailLines(cleanTurnLines(screen(name)), 14))
    expect(old).not.toBeNull()
    expect(waitChoiceOfScreen(screen(name))).toMatchObject({ question: old?.question, cursor: old?.cursor })
    expect(waitChoiceOfScreen(screen(name))?.options.map((o) => o.label)).toEqual(old?.options.map((o) => o.label))
  })
  it('a screen with no menu is nothing', () => {
    expect(waitChoiceOfScreen('⏺ Done.\n\n1. first\n2. second\n\n❯ \n')).toBeNull()
  })
})

describe('a read through herdr (a card with no mirror)', () => {
  it('reads the same menu off recent-unwrapped', () => {
    const choice = read('claude-herdr-recent-multi')
    expect(choice.question).toBe('Which notes should go in?')
    expect(labels(choice)).toEqual(['Alpha', 'Beta', 'Type something', 'Submit', 'Chat about this'])
    expect(choice.steps).toEqual({ done: 0, total: 1 })
  })
})

describe('a plan offered to an agent launched in bypass mode', () => {
  const PLAN = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-plan-bypass.txt'), 'utf8')
  it('keeps the row that names the mode, which reads like the status line', () => {
    const choice = waitChoiceOfScreen(PLAN)
    expect(choice?.options.map((o) => o.key)).toEqual(['1', '2', '3'])
    expect(choice?.options[0].label).toContain('BYPASS PERMISSIONS')
    expect(choice?.cursor).toBe(0)
    expect(menuHeldOnScreen(PLAN)).toBe(true)
  })
  it('the real status line still goes', () => {
    expect(cleanTurnLines('⏵⏵ bypass permissions on (shift+tab to cycle)\nhello\n')).toEqual(['hello', ''])
  })
})

describe("the row that writes an always-allow rule (Menu QA F12)", () => {
  // Under its cursor the row is an input: a digit lands in the rule, 'cookrew note *1'.
  const ON_RULE = waitChoiceOfScreen(readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-rule-row-cursor.txt'), 'utf8')) as WaitChoice
  it('reads as the row it is', () => {
    expect(ON_RULE.cursor).toBe(1)
    expect(ON_RULE.options[1].label).toMatch(/ask again for: cookrew note/)
  })
  it('from it, rows are reached by arrows and Enter, never a digit', () => {
    expect(answerKeys(ON_RULE, { kind: 'row', index: 0 })).toEqual(['\x1b[A', '\r'])
    expect(answerKeys(ON_RULE, { kind: 'row', index: 3 })).toEqual(['\x1b[B\x1b[B', '\r'])
  })
  it('on it, Enter takes it', () => {
    expect(answerKeys(ON_RULE, { kind: 'row', index: 1 })).toEqual(['\r'])
  })
  it('from another row it is reached the same way: its digit may only open the field', () => {
    expect(answerKeys({ ...ON_RULE, cursor: 0 }, { kind: 'row', index: 1 })).toEqual(['\x1b[B', '\r'])
  })
  it('other rows keep their digit', () => {
    expect(answerKeys({ ...ON_RULE, cursor: 0 }, { kind: 'row', index: 3 })).toEqual(['4'])
  })
})

describe('a menu held up, sure enough to decide a turn', () => {
  const read = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'wait-choice', `${name}.txt`), 'utf8')
  const MENUS = ['claude-ask', 'claude-ask-multi-narrow-zh', 'claude-bash', 'claude-create', 'claude-edit', 'claude-plan', 'claude-tabs-multi', 'claude-tabs-q1', 'claude-tabs-q2', 'claude-tabs-review', 'claude-tabs-q2-typed', 'claude-edit-cursor-2', 'claude-herdr-recent-multi', 'codex-command']
  it.each(MENUS)('%s holds one', (name) => {
    expect(menuHeldOnScreen(read(name))).toBe(true)
  })
  it('the rows alone do not: a prompt echo under a question', () => {
    const screen = 'Which should go first?\n\n❯ 1. rename foo\n  2. rename bar\n\n⏺ Done.\n'
    expect(waitChoiceOfScreen(screen)).not.toBeNull()
    expect(menuHeldOnScreen(screen)).toBe(false)
  })
  it('nor an echo over the idle box, its reply not yet drawn', () => {
    const screen = 'Which should go first?\n\n❯ 1. rename foo\n  2. rename bar\n\n───────────────────────────────────\n❯ \n───────────────────────────────────\n  ? for shortcuts\n'
    expect(menuHeldOnScreen(screen)).toBe(false)
  })
  it('nor a draft in the box itself, under a reply that asks (Claude)', () => {
    const screen = '⏺ Should I rename these,\n  or leave them?\n\n───────────────────────────────────\n❯ 1. a\n  2. b\n───────────────────────────────────\n  ? for shortcuts\n'
    expect(menuHeldOnScreen(screen)).toBe(false)
  })
  it('nor a draft in the box itself, under a reply that asks (Codex)', () => {
    const screen = '• Should I rename these,\n  or leave them?\n\n› 1. a\n  2. b\n\n  ? for shortcuts\n'
    expect(menuHeldOnScreen(screen)).toBe(false)
  })
  it('a reply with a numbered list over the idle box does not', () => {
    const screen = '⏺ Two ways:\n  1. Patch it\n  2. Revert it\n\n  Which do you want?\n\n───────────────────────────────────\n❯ \n───────────────────────────────────\n  ? for shortcuts\n'
    expect(menuHeldOnScreen(screen)).toBe(false)
  })
})
