// The multiplexer's screen guess reads Claude Code's `/model` picker as work,
// then as a question: a mirrorless card showed working → waiting → working →
// done over a picker that ran no turn (status eval r5, phone, 2 of 3 tries).
// And an accented verb ("Sautéed for 18s") never read as a finished line.

import { describe, expect, it } from 'vitest'
import { lastStatusLine, uiCommandOpen } from '../src/shared/turn'

const RULE = '─'.repeat(60)

const PICKER = [
  '⏺ DONE',
  '',
  '✻ Churned for 7s',
  '',
  '❯ /model',
  RULE,
  '  Select model',
  '  Switch between Claude models.',
  '    48. Claude Sonnet 5.5 · Claude Code',
  '  ❯ 49. Claude Opus 5.5 · Claude Code ✔',
  '  ● High effort ←/→ to adjust',
  '  Enter to set as default · s to use this session only · Esc to cancel'
].join('\n')

const AFTER_ESC = [
  '❯ /model',
  '  ⎿  Kept model as Opus 5.5',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
].join('\n')

const QUESTION = [
  '❯ Use the AskUserQuestion tool to ask me to pick A or B.',
  '',
  '⏺ User answered nothing yet',
  RULE,
  ' Pick one',
  '❯ 1. A',
  '  2. B',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n')

describe('uiCommandOpen', () => {
  it('reads the /model picker as the agent UI, not a turn', () => {
    expect(uiCommandOpen(PICKER)).toBe(true)
  })

  it('stays true on the screen the picker leaves behind', () => {
    expect(uiCommandOpen(AFTER_ESC)).toBe(true)
  })

  it('a real question menu is not a UI command', () => {
    expect(uiCommandOpen(QUESTION)).toBe(false)
  })

  it('a prompt sent after the command ends it', () => {
    const screen = `${AFTER_ESC.split(RULE)[0]}❯ fix the bug\n⏺ Reading the file\n${RULE}\n❯ \n${RULE}`
    expect(uiCommandOpen(screen)).toBe(false)
  })

  it('agent work after the command ends it', () => {
    expect(uiCommandOpen(`❯ /model\n  ⎿  Kept model\n✻ Pondering… (3s · esc to interrupt)\n${RULE}\n❯ \n${RULE}`)).toBe(false)
  })

  it('a command that runs a turn is not a UI command', () => {
    expect(uiCommandOpen(`❯ /compact\n${RULE}\n❯ \n${RULE}`)).toBe(false)
  })

  it('/model typed into the box during a real turn is a draft, not an open command (review)', () => {
    const screen = `❯ fix the bug\n⏺ Reading\n✻ Pondering… (12s · esc to interrupt)\n${RULE}\n❯ /model\n${RULE}\n  ⏵⏵ bypass permissions on`
    expect(uiCommandOpen(screen)).toBe(false)
  })

  it('/model drafted in the box at rest is not an open command either', () => {
    expect(uiCommandOpen(`⏺ DONE\n\n✻ Churned for 7s\n${RULE}\n❯ /model\n${RULE}`)).toBe(false)
  })

  it('a reply that quotes a command is not an echo (review)', () => {
    expect(uiCommandOpen(`❯ how do I switch models?\n⏺ Run this:\n  > /model\n${RULE}\n❯ \n${RULE}`)).toBe(false)
  })

  it('a bare screen says nothing', () => {
    expect(uiCommandOpen('')).toBe(false)
    expect(uiCommandOpen(`${RULE}\n❯ \n${RULE}`)).toBe(false)
  })
})

describe('finished status lines with accented verbs', () => {
  it('reads "Sautéed for 18s" as finished, like "Churned for 17s"', () => {
    expect(lastStatusLine('✻ Sautéed for 18s')?.finished).toBe(true)
    expect(lastStatusLine('✻ Churned for 17s')?.finished).toBe(true)
  })
})
