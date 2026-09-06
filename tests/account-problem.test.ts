// THE RED BOX WITH NO CAUSE IN IT.
//
// Real-UI QA, owner on the desktop SECURITY tab: a red box reading only that
// something had gone wrong. That sentence lived in eleven catch blocks across
// this directory, so it could not tell anyone WHICH of eleven calls had
// failed — and it was shown for a thrown IPC rejection, the one case where
// the app holds something concrete: the error's own message.
//
// WHICH ONE THE OWNER HIT. Every other generic sentence on that tab is behind
// a press (SHOW, SAVE AS FILE, REMOVE, ADD). The factors read is the only one
// that runs on mount, so a box that was simply THERE was the factors read —
// which is also why the passkey the registry had was never listed: `factors`
// stayed null and the card fell back to its "add one" row. One cause, both
// symptoms. Below, each path is exercised against a refusing and a throwing
// bridge, and the directory is swept for the sentence itself.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOING, answerProblem, problemSentence, refusedSentence } from '../src/renderer/src/account/problem'

const ACCOUNT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'src', 'account')

afterEach(() => vi.restoreAllMocks())

describe('a call that THREW says what failed and what it said', () => {
  it('names the attempt and carries the message the bridge gave', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sentence = problemSentence(
      DOING.FACTORS,
      new Error("Error invoking remote method 'account:factors': no handler registered"),
    )
    expect(sentence).toContain('Your security settings could not be read')
    // The channel's name is in it: the difference between a bug report and a
    // shrug is knowing which invoke rejected.
    expect(sentence).toContain('account:factors')
  })

  it('sends the error itself to the console, so the stack survives', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const boom = new Error('EROFS: read-only file system')
    problemSentence(DOING.LOCK, boom)
    expect(logged).toHaveBeenCalledWith(`${DOING.LOCK}:`, boom)
  })

  it('says so plainly when the throwable carried nothing to say', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(problemSentence(DOING.CODES, undefined)).toBe(
      'New recovery codes could not be made: the app got no reason back',
    )
    expect(problemSentence(DOING.CODES, 'channel closed')).toContain('channel closed')
  })
})

describe('a call that ANSWERED NO', () => {
  it('shows the registry’s own sentence, verbatim and alone', () => {
    const refusal = { reason: 'unknown' as const, message: 'Type your password to take a factor off the account.' }
    expect(refusedSentence(DOING.REMOVE_FACTOR, refusal)).toBe(refusal.message)
  })

  it('otherwise says what was attempted, then why', () => {
    const sentence = refusedSentence(DOING.PROFILE, { reason: 'session-expired' })
    expect(sentence).toContain('Your account could not be read from cookrew.dev')
    expect(sentence).toContain('Your session ended')
  })

  it('is null when nothing went wrong', () => {
    expect(answerProblem(DOING.DEVICES, { ok: true, value: [] })).toBeNull()
  })
})

describe('the four paths the owner could have been on', () => {
  // A bridge that refuses everything, and one that throws: the SECURITY tab's
  // read, the lock, the codes and the file. Each has to be distinguishable on
  // screen — that is the whole repair.
  const refusing = [DOING.FACTORS, DOING.LOCK, DOING.CODES, DOING.SAVE_CODES].map((doing) =>
    refusedSentence(doing, { reason: 'unknown' }),
  )
  const throwing = [DOING.FACTORS, DOING.LOCK, DOING.CODES, DOING.SAVE_CODES].map((doing) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    return problemSentence(doing, new Error('EACCES'))
  })

  it('reads differently for each, refused or thrown', () => {
    expect(new Set(refusing).size).toBe(4)
    expect(new Set(throwing).size).toBe(4)
  })

  it('never asks a person to simply try again with no cause', () => {
    for (const sentence of [...refusing, ...throwing]) {
      expect(sentence).not.toContain('went wrong on this side')
      expect(sentence.length).toBeGreaterThan(20)
    }
  })

  it('says NOTHING WAS CHANGED when the registry answered unreadably', () => {
    expect(refusing[0]).toContain('Nothing was changed')
  })
})

describe('the sentence is gone from the whole account surface', () => {
  const files = readdirSync(ACCOUNT_DIR).filter((name) => /\.tsx?$/.test(name))

  it('sweeps every file in src/renderer/src/account/', () => {
    expect(files.length).toBeGreaterThan(10)
    const carrying = files.filter((name) =>
      readFileSync(path.join(ACCOUNT_DIR, name), 'utf8').includes('went wrong on this side'),
    )
    expect(carrying).toEqual([])
  })
})
