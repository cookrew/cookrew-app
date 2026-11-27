// Devin CLI's unnumbered selector, as Cookrew's prompt box, phone and turn
// tracker read it. The screen is a real Devin 3000.14 approval (2026-11-26).

import { describe, expect, it } from 'vitest'
import { answerKeys, choiceId, dialogOnScreen, menuHeldOnScreen, waitChoiceOfScreen } from '../src/shared/wait-choice'

const APPROVAL = [
  'Context: 16k / 262k tokens (6%)',
  '⏺ Writing',
  './hello.txt',
  ' └ 1 +  hi',
  '❭ Allow  Write(/private/tmp/work)',
  '  Accept edits mode',
  '  Bypass mode',
  '  Deny',
  '↑↓ select · ↵ confirm · esc cancel'
].join('\n')

describe('Devin approval menu', () => {
  it('reads its rows, cursor, what it is doing and its Deny row', () => {
    const choice = waitChoiceOfScreen(APPROVAL)
    expect(choice).toMatchObject({
      kind: 'menu',
      question: 'Allow Write(/private/tmp/work)?',
      sub: 'Writing ./hello.txt',
      cursor: 0,
      escIndex: 3
    })
    expect(choice?.options.map((o) => o.label)).toEqual(['Allow Write(/private/tmp/work)', 'Accept edits mode', 'Bypass mode', 'Deny'])
  })

  it('answers by arrows from the cursor, then Enter in a write of its own', () => {
    const choice = waitChoiceOfScreen(APPROVAL)!
    expect(answerKeys(choice, { kind: 'row', index: 0 })).toEqual(['\r'])
    expect(answerKeys(choice, { kind: 'row', index: 3 })).toEqual(['\x1b[B\x1b[B\x1b[B', '\r'])
    const moved = waitChoiceOfScreen(APPROVAL.replace('❭ Allow', '  Allow').replace('  Deny', '❭ Deny'))!
    expect(answerKeys(moved, { kind: 'row', index: 0 })).toEqual(['\x1b[A\x1b[A\x1b[A', '\r'])
    // The cursor is no part of the menu's identity: an answer names the same menu.
    expect(choiceId(moved)).toBe(choiceId(choice))
  })

  it('is a held menu (the turn waits), and a dialog the first task must not type into', () => {
    expect(menuHeldOnScreen(APPROVAL)).toBe(true)
    expect(dialogOnScreen(APPROVAL)).toBe(true)
    expect(dialogOnScreen('❭ 1 Use locally detected account\n   5 Skip for now\n ↑↓ select · ↵ confirm · esc skip')).toBe(true)
  })

  it('needs its footer: rows in a reply are not a menu', () => {
    const reply = ['⏺ Options', '❭ first', '  second', '  third'].join('\n')
    expect(waitChoiceOfScreen(reply)).toBeNull()
    expect(menuHeldOnScreen(reply)).toBe(false)
  })

  it('answered and the transcript going on under it: no longer held', () => {
    expect(menuHeldOnScreen(`${APPROVAL}\n⏺ Wrote ./hello.txt`)).toBe(false)
  })
})
