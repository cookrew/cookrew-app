// THE WAIT CHOICE BOX's reading (owner task, 2026-11-04; cut
// docs/avatar-send-tasks/g-choice). A waiting turn's lines become the menu
// the agent's TUI is showing, or nothing.
//
// Fixtures are real panes (tests/fixtures/wait-choice), captured 2026-11-04
// from Claude Code 2.1.316 and codex-cli 0.166.0 in a private tmux server, and
// fed through the tracker's own path: cleanTurnLines, then the 14-line tail
// the activity carries (turn-tracker.ts · SUMMARY_TAIL).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanTurnLines, tailLines } from '../src/shared/turn'
import { choiceKeys, choiceSig, keyChoice, parseWaitChoice, type WaitChoice } from '../src/shared/wait-choice'

const SUMMARY_TAIL = 14
const pane = (name: string): string[] => tailLines(cleanTurnLines(readFileSync(join(__dirname, 'fixtures', 'wait-choice', `${name}.txt`), 'utf8')), SUMMARY_TAIL)
const parsed = (name: string): WaitChoice => {
  const choice = parseWaitChoice(pane(name))
  if (!choice) throw new Error(`${name}: no choice`)
  return choice
}
const labels = (choice: WaitChoice): string[] => choice.options.map((o) => o.label)

describe('parseWaitChoice · Claude Code permission menus', () => {
  it('reads an edit: the question, the three options, the cursor on 1 and "No" as the Esc row', () => {
    const choice = parsed('claude-edit')
    expect(choice.kind).toBe('menu')
    expect(choice.question).toBe('Do you want to make this edit to a.ts?')
    expect(choice.sub).toBe('Edit · a.ts · +1 −1')
    expect(labels(choice)).toEqual(['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session', 'No'])
    expect(choice.options.map((o) => o.key)).toEqual(['1', '2', '3'])
    expect(choice.cursor).toBe(0)
    expect(choice.escIndex).toBe(2)
  })

  it('follows the TUI cursor when it moves', () => {
    expect(parsed('claude-edit-cursor-2').cursor).toBe(1)
  })

  it('reads a new file and a bash command with what they touch', () => {
    const create = parsed('claude-create')
    expect(create.question).toBe('Do you want to create b.ts?')
    expect(create.sub).toBe('Create · b.ts')
    expect(create.escIndex).toBe(2)
    const bash = parsed('claude-bash')
    expect(bash.question).toBe('Do you want to proceed?')
    expect(bash.sub).toBe('Bash · mkdir -p /tmp/wc-fix/claude/d1')
    expect(labels(bash)).toEqual(['Yes', 'Yes, and always allow access to /tmp/wc-fix/claude from this project', 'Yes, and switch to auto mode', 'No'])
    expect(bash.options[2].detail).toBe('auto mode handles these prompts for you')
    expect(bash.escIndex).toBe(3)
  })

  it('reads plan approval past the plan\'s own numbered steps', () => {
    const plan = parsed('claude-plan')
    expect(plan.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?')
    expect(plan.sub).toBe('Plan')
    expect(labels(plan)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
    expect(plan.cursor).toBe(0)
    expect(plan.escIndex).toBe(2)
  })

  it('reads a question tool menu with its descriptions, and no Esc row', () => {
    const ask = parsed('claude-ask')
    expect(ask.question).toBe('Which color do you want?')
    expect(ask.sub).toBe('Color')
    expect(labels(ask)).toEqual(['Red', 'Blue', 'Type something.', 'Chat about this'])
    expect(ask.options[0].detail).toBe('A warm, bold color.')
    expect(ask.escIndex).toBe(null)
  })

  it('leaves the unnumbered folder-trust menu alone: no box, the keys stay', () => {
    expect(parseWaitChoice(pane('claude-trust'))).toBe(null)
  })
})

describe('parseWaitChoice · Codex menus', () => {
  it('reads a command approval: the question over the reason, the command as the sub, shortcut letters out of the labels', () => {
    const choice = parsed('codex-command')
    expect(choice.question).toBe('Would you like to run the following command?')
    expect(choice.sub).toBe('$ touch /tmp/wc-fix/codex/c.txt')
    expect(labels(choice)).toEqual(['Yes, proceed', "Yes, and don't ask again for commands that start with `touch /tmp/wc-fix/codex/c.txt`", 'No, and tell Codex what to do differently'])
    expect(choice.cursor).toBe(0)
    expect(choice.escIndex).toBe(2)
  })

  it('reads the folder trust menu, the question cut at its "?"', () => {
    const choice = parsed('codex-trust')
    expect(choice.question).toBe('Trust this folder?')
    expect(labels(choice)).toEqual(['Trust and continue', 'Back to Agent Command Center'])
    expect(choice.escIndex).toBe(null)
  })
})

describe('parseWaitChoice · y/n confirms', () => {
  it('reads "(y/n)?" with the line above as the sub', () => {
    const choice = parsed('ssh-keygen-confirm')
    expect(choice.kind).toBe('yn')
    expect(choice.question).toBe('Overwrite?')
    expect(choice.sub).toBe('/tmp/wc-fix/k already exists.')
    expect(choice.options).toEqual([
      { key: 'y', label: 'Yes', detail: null },
      { key: 'n', label: 'No', detail: null }
    ])
    expect(choice.cursor).toBe(null)
  })

  it('reads npx\'s "(y)" as a yes-default confirm', () => {
    const choice = parsed('npx-confirm')
    expect(choice.kind).toBe('yn')
    expect(choice.question).toBe('Ok to proceed?')
    expect(choice.cursor).toBe(0)
  })

  it('takes the default from the capital: [Y/n] is yes, [y/N] is no', () => {
    expect(parseWaitChoice(['Continue? [Y/n]'])?.cursor).toBe(0)
    expect(parseWaitChoice(['Delete it? [y/N] '])?.cursor).toBe(1)
  })
})

describe('parseWaitChoice · anything else is null', () => {
  it('a free question, a reply, nothing', () => {
    expect(parseWaitChoice([])).toBe(null)
    expect(parseWaitChoice(['⏺ Which name do you want for the lane?'])).toBe(null)
    expect(parseWaitChoice(['Done. I fixed the bug in pty.ts.', 'All 22 tests pass.'])).toBe(null)
  })

  it('a numbered list in a reply is not a menu: no cursor, no menu footer', () => {
    const reply = ['⏺ Would you like me to:', '  1. Ship it now', '  2. Wait for review', '', '❯ ']
    expect(parseWaitChoice(reply)).toBe(null)
  })

  it('a menu that is not the screen\'s last thing is history, not the question', () => {
    const lines = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', '⏺ Bash(ls)', '  ⎿  a.ts', '⏺ Listed the folder.', '  It holds a.ts and b.ts.', '  Nothing else is there.', '✻ Baked for 3s']
    expect(parseWaitChoice(lines)).toBe(null)
  })

  it('a numbered prompt echo is no menu: its ❯ is not a cursor without a question (review)', () => {
    const lines = ['✻ Baked for 8s · done 6:42 AM', '❯ 1. rename foo to bar', '  2. update the tests', '⏺ Done both. Would you like me to also update the docs?', '✻ Worked for 9s', '❯ ']
    expect(parseWaitChoice(lines)).toBe(null)
  })

  it('needs two options counted from 1', () => {
    expect(parseWaitChoice([' Pick one?', ' ❯ 1. Only'])).toBe(null)
    expect(parseWaitChoice([' Pick one?', ' ❯ 2. A', '   3. B', ' Esc to cancel'])).toBe(null)
  })
})

describe('choiceKeys: what a tap sends through the live line', () => {
  it('a numbered row is its digit, the Esc row too (the TUI takes it wherever the cursor is)', () => {
    const choice = parsed('claude-edit')
    expect(choiceKeys(choice, 0)).toBe('1')
    expect(choiceKeys(choice, 1)).toBe('2')
    expect(choiceKeys(choice, 2)).toBe('3')
    expect(choiceKeys(parsed('codex-command'), 2)).toBe('3')
  })

  it('a "No, …" that is an answer of its own is no Esc row (review: it sent Esc)', () => {
    const lines = ['  Trust this folder?', '', '› 1. Yes, allow Codex to work in this folder without asking', '  2. No, ask me to approve edits and commands', '', '  Press enter to continue']
    const choice = parseWaitChoice(lines)
    expect(choice?.escIndex).toBe(null)
    expect(choiceKeys(choice as WaitChoice, 1)).toBe('2')
    expect(parseWaitChoice([' Go on?', ' ❯ 1. Yes', '   2. No (recommended)', ' Enter to confirm · Esc to cancel'])?.escIndex).toBe(null)
  })

  it('a y/n row is its letter and Enter', () => {
    const choice = parsed('ssh-keygen-confirm')
    expect(choiceKeys(choice, 0)).toBe('y\r')
    expect(choiceKeys(choice, 1)).toBe('n\r')
  })

  it('past 9, arrows from the cursor and Enter; with no cursor it cannot be sent', () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ key: String(i + 1), label: `Option ${i + 1}`, detail: null }))
    const menu: WaitChoice = { kind: 'menu', question: 'Pick?', sub: null, options, cursor: 8, escIndex: null }
    expect(choiceKeys(menu, 10)).toBe('\x1b[B\x1b[B\r')
    expect(choiceKeys({ ...menu, cursor: null }, 10)).toBe(null)
    expect(choiceKeys(menu, 11)).toBe(null)
  })
})

describe('keyChoice: a key pressed with the box empty', () => {
  it('a digit picks its row, y/n theirs, anything else nothing', () => {
    const menu = parsed('claude-edit')
    expect(keyChoice(menu, '2')).toBe(1)
    expect(keyChoice(menu, '4')).toBe(null)
    expect(keyChoice(menu, 'y')).toBe(null)
    const yn = parsed('ssh-keygen-confirm')
    expect(keyChoice(yn, 'n')).toBe(1)
    expect(keyChoice(yn, 'y')).toBe(0)
    // A capital starts a sentence ("No, use pnpm"): words, not an answer.
    expect(keyChoice(yn, 'N')).toBe(null)
    expect(keyChoice(yn, '1')).toBe(null)
  })
})

describe('choiceSig: one question, whatever the cursor', () => {
  it('stays when the cursor moves, changes with the question', () => {
    expect(choiceSig(parsed('claude-edit'))).toBe(choiceSig(parsed('claude-edit-cursor-2')))
    expect(choiceSig(parsed('claude-edit'))).not.toBe(choiceSig(parsed('claude-create')))
  })

  it('two commands asking the same words are two questions (review: the second hid)', () => {
    const next = parseWaitChoice(pane('claude-bash').map((l) => l.replace('/claude/d1', '/claude/d2'))) as WaitChoice
    expect(choiceSig(next)).not.toBe(choiceSig(parsed('claude-bash')))
  })
})
