// agy's approval menu, as Cookrew's prompt box and phone read it: the screen
// is the one agy 1.5.18 drew in --mode accept-edits for a shell command
// (isolated e2e, 2026-11-27). Rows are numbered, so a digit answers them.

import { describe, expect, it } from 'vitest'
import { waitChoiceOfScreen } from '../src/shared/wait-choice'

const SCREEN = [
  '> Run the shell command: touch e2e-approval.txt',
  '',
  '● Ran (touch e2e-approval.txt) (ctrl+o to expand)',
  '',
  'Command',
  '',
  '',
  'Requesting permission for:',
  '   touch e2e-approval.txt',
  '',
  'Run this command?',
  '> 1. Yes, run command',
  "  2. Yes, and always allow in this conversation for commands that start with 'touch'",
  "  3. Yes, and always allow for commands that start with 'touch' (Persist to settings.json)",
  '  4. No, cancel',
  '',
  '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
  'esc to cancel                                    accept-edits · Gemini 4 Hydrogen · high'
].join('\n')

describe('agy approval menu', () => {
  it('reads as a four-row menu with its question and the cursor on the first row', () => {
    const choice = waitChoiceOfScreen(SCREEN)
    expect(choice?.kind).toBe('menu')
    expect(choice?.question).toBe('Run this command?')
    expect(choice?.options.map((o) => o.label)).toEqual([
      'Yes, run command',
      "Yes, and always allow in this conversation for commands that start with 'touch'",
      "Yes, and always allow for commands that start with 'touch' (Persist to settings.json)",
      'No, cancel'
    ])
    expect(choice?.cursor).toBe(0)
  })
})
