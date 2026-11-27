// Where a hosted agent's sessions live and how a card binds one (src/main/hosted-bind.ts).

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  dshSessionExists,
  hostedNewerTranscript,
  hostedResumeCommand,
  hostedSessionFromOpenFiles,
  hostedSessionOfFile,
  hostedTranscriptFile,
  hostedWatchFile,
  resolveHostedSessionByPid,
  stripHostedSessionFlags,
  validHostedSessionId
} from '../src/main/hosted-bind'

const ID = 'addff6fc-dbb7-4d65-9721-250105b33631'
const home = (): string => mkdtempSync(path.join(tmpdir(), 'hosted-home-'))

describe('hosted session ids', () => {
  it('accepts the host alphabet and nothing that could leave the folder', () => {
    for (const good of [ID, 'abc', 'A_1.2-3']) expect(validHostedSessionId(good)).toBe(true)
    for (const bad of ['../x', 'a/b', '..', '', '-x', 'a'.repeat(129), null, 7]) expect(validHostedSessionId(bad)).toBe(false)
  })

  it('a transcript path names its session; anything else names none', () => {
    const h = home()
    expect(hostedSessionOfFile(hostedTranscriptFile('dsh', ID, h))).toBe(ID)
    expect(hostedSessionOfFile(path.join(h, 'elsewhere', `${ID}.jsonl`))).toBeUndefined()
    expect(hostedSessionOfFile(path.join(h, '.cookrew', 'hosted', 'dsh', 'x', `${ID}.jsonl`))).toBeUndefined()
    expect(() => hostedTranscriptFile('../evil', ID, h)).toThrow()
  })
})

describe('binding by the transcript the host holds open', () => {
  it('reads it among open files; refuses one outside the folder', () => {
    const dir = path.join(home(), '.cookrew', 'hosted', 'dsh')
    expect(hostedSessionFromOpenFiles([`${dir}/${ID}.jsonl`, '/x/y'], dir)).toBe(ID)
    expect(hostedSessionFromOpenFiles([`${dir}/nested/${ID}.jsonl`], dir)).toBeNull()
    expect(hostedSessionFromOpenFiles([`/tmp/hosted/dsh/${ID}.jsonl`], dir)).toBeNull()
    expect(hostedSessionFromOpenFiles([`${dir}/patches/card-1.yml`], dir)).toBeNull()
  })

  it("walks the pane's process tree; a dir reached through a symlink still matches", () => {
    const h = home()
    mkdirSync(path.join(h, '.cookrew', 'hosted', 'dsh'), { recursive: true })
    const file = path.join(h, '.cookrew', 'hosted', 'dsh', `${ID}.jsonl`)
    writeFileSync(file, '')
    const children = (pid: number): number[] => ({ 10: [11] })[pid] ?? []
    expect(resolveHostedSessionByPid('dsh', 10, (pid) => (pid === 11 ? [file] : []), children, h)).toBe(ID)
    expect(resolveHostedSessionByPid('dsh', null, () => [file], children, h)).toBeNull()
    if (process.platform !== 'win32') {
      const link = path.join(home(), 'dsh')
      symlinkSync(path.join(h, '.cookrew', 'hosted', 'dsh'), link)
      expect(hostedSessionFromOpenFiles([path.join(realpathSync(path.join(h, '.cookrew', 'hosted', 'dsh')), `${ID}.jsonl`)], link)).toBe(ID)
    }
  })

  it('the watch file needs a valid bound id', () => {
    const h = home()
    expect(hostedWatchFile('dsh', ID, h)).toBe(hostedTranscriptFile('dsh', ID, h))
    expect(hostedWatchFile('dsh', '../x', h)).toBeNull()
    expect(hostedWatchFile('dsh', undefined, h)).toBeNull()
  })

  it('a newer transcript than the bound one is the follow hint', () => {
    const h = home()
    const dir = path.join(h, '.cookrew', 'hosted', 'dsh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${ID}.jsonl`), '')
    expect(hostedNewerTranscript('dsh', ID, h)).toBe(false)
    const later = path.join(dir, 'another-session.jsonl')
    writeFileSync(later, '')
    utimesSync(later, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(hostedNewerTranscript('dsh', ID, h)).toBe(true)
    expect(hostedNewerTranscript('dsh', 'missing', h)).toBe(false)
  })
})

describe('hosted resume and copies', () => {
  it('resumes with --resume, replacing an earlier one', () => {
    expect(hostedResumeCommand('cookrew-acp dsh --model x', ID)).toBe(`cookrew-acp dsh --model x --resume ${ID}`)
    expect(hostedResumeCommand(`cookrew-acp dsh --resume=${ID} --model x`, ID)).toBe(`cookrew-acp dsh --model x --resume ${ID}`)
    expect(stripHostedSessionFlags(`cookrew-acp dsh -x --resume ${ID} --model m`)).toBe('cookrew-acp dsh -x --model m')
    expect(stripHostedSessionFlags('cookrew-acp dsh --resume')).toBe('cookrew-acp dsh')
  })

  it("dsh's own copy of a session is what resumes it", () => {
    const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-home-'))
    expect(dshSessionExists(ID, dshHome)).toBe(false)
    mkdirSync(path.join(dshHome, 'sessions', '--work--', ID), { recursive: true })
    expect(dshSessionExists(ID, dshHome)).toBe(true)
    expect(dshSessionExists('../x', dshHome)).toBe(false)
  })
})
