// Antigravity CLI binding, resume and launch line (src/main/agy-bind.ts),
// and its model offer (src/main/agy-models.ts). Paths and lsof output are the
// shapes read off agy 1.5.18 on 2026-11-26.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agyConversationExists,
  agyConversationFromOpenFiles,
  agyConversationOfFile,
  agyLastConversation,
  agyResumeCommand,
  agySessionLine,
  agyTranscriptFile,
  agyWatchFile,
  resolveAgyConversationByPid,
  stripAgySessionFlags,
  validAgyConversationId
} from '../src/main/agy-bind'
import { agyLaunchOffer, agyOfferOf, agySlugsOf } from '../src/main/agy-models'

const ID = '73f44614-99dc-4b12-a26c-92c3a56c594e'
const DATA = '/Users/me/.gemini/antigravity-cli'

describe('agy conversation ids', () => {
  it('accepts lowercase UUIDs only', () => {
    expect(validAgyConversationId(ID)).toBe(true)
    for (const bad of [ID.toUpperCase(), '../../etc/passwd', `${ID}; rm -rf /`, 'wary-seeker', '', null, 7]) {
      expect(validAgyConversationId(bad)).toBe(false)
    }
  })

  it('a transcript path names its conversation; any other path names none', () => {
    expect(agyConversationOfFile(agyTranscriptFile(ID, DATA))).toBe(ID)
    expect(agyConversationOfFile('/tmp/brain/not-a-uuid/x.jsonl')).toBeUndefined()
    expect(agyConversationOfFile('/tmp/transcript.jsonl')).toBeUndefined()
  })
})

describe('binding by the presence lock the agy process holds', () => {
  const files = [
    `${DATA}/conversation_summaries.db`,
    `${DATA}/conversations/${ID}.db`,
    `${DATA}/presence/${ID}.lock`
  ]

  it('finds the conversation from the open presence lock', () => {
    expect(agyConversationFromOpenFiles(files, DATA)).toBe(ID)
    expect(resolveAgyConversationByPid(42, () => files)).toBeNull() // default data dir is not DATA
  })

  it('a data dir reached through a symlink still matches the resolved path lsof prints', () => {
    const real = mkdtempSync(path.join(tmpdir(), 'agy-real-'))
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'agy-link-')), 'antigravity-cli')
    symlinkSync(real, link)
    expect(agyConversationFromOpenFiles([`${realpathSync(real)}/presence/${ID}.lock`], link)).toBe(ID)
  })

  it('before the first turn there is no lock and nothing to bind', () => {
    expect(agyConversationFromOpenFiles([`${DATA}/presence`, `${DATA}/brain`], DATA)).toBeNull()
  })

  it('refuses a lock outside the data dir and a planted name', () => {
    expect(agyConversationFromOpenFiles([`/tmp/presence/${ID}.lock`], DATA)).toBeNull()
    expect(agyConversationFromOpenFiles([`${DATA}/presence/../evil.lock`, `${DATA}/presence/x.lock`], DATA)).toBeNull()
  })

  it('no pid, no lookup', () => {
    const read = vi.fn(() => files)
    expect(resolveAgyConversationByPid(null, read)).toBeNull()
    expect(resolveAgyConversationByPid(0, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('agy resume and copies', () => {
  it('resumes with --conversation, replacing any earlier session flag', () => {
    expect(agyResumeCommand('agy --mode accept-edits', ID)).toBe(`agy --mode accept-edits --conversation ${ID}`)
    expect(agyResumeCommand(`agy -r 11111111-1111-4111-8111-111111111111 --mode plan`, ID)).toBe(`agy --mode plan --conversation ${ID}`)
  })

  it('a copy keeps no conversation, no -c guess and no session settings', () => {
    const line = `agy --model gemini-4-hydrogen --conversation ${ID} -c --resume=${ID} --settings '{"trustedWorkspaces":["/x"]}' --effort high`
    expect(stripAgySessionFlags(line)).toBe('agy --model gemini-4-hydrogen --effort high')
  })

  it('the watch file needs a valid bound id', () => {
    expect(agyWatchFile({ agySessionId: ID }, { agyDataDir: DATA })).toBe(`${DATA}/brain/${ID}/.system_generated/logs/transcript.jsonl`)
    expect(agyWatchFile({ agySessionId: '../../x' }, { agyDataDir: DATA })).toBeNull()
    expect(agyWatchFile({}, { agyDataDir: DATA })).toBeNull()
  })

  it('a conversation exists when its store does', () => {
    const data = mkdtempSync(path.join(tmpdir(), 'agy-data-'))
    mkdirSync(path.join(data, 'conversations'))
    expect(agyConversationExists(ID, data)).toBe(false)
    writeFileSync(path.join(data, 'conversations', `${ID}.db`), '')
    expect(agyConversationExists(ID, data)).toBe(true)
    expect(agyConversationExists('../conversations/x', data)).toBe(false)
  })
})

describe('agy session line', () => {
  it('trusts the folder as given AND as resolved: agy asks about the given one', () => {
    const dir = mkdtempSync('/tmp/agy-trust-')
    const line = agySessionLine('agy', dir)
    expect(line).toContain(`"trustedWorkspaces":["${dir}","/private${dir}"]`)
  })

  it('trusts the card folder and renders inline, as one shell word', () => {
    const line = agySessionLine('agy --mode accept-edits', '/no/such/dir it')
    expect(line).toBe(`agy --mode accept-edits --settings '{"trustedWorkspaces":["/no/such/dir it"],"altScreenMode":"never"}'`)
    expect(stripAgySessionFlags(line)).toBe('agy --mode accept-edits')
  })

  it('a folder with a quote stays one word', () => {
    expect(agySessionLine('agy', "/tmp/o'brien")).toBe(`agy --settings '{"trustedWorkspaces":["/tmp/o'\\''brien"],"altScreenMode":"never"}'`)
  })

  it('a line that sets its own --settings keeps them', () => {
    expect(agySessionLine(`agy --settings /x.json`, '/w')).toBe('agy --settings /x.json')
  })
})

describe("agy's folder index (the follow hint)", () => {
  it("reads the folder's latest conversation, by the folder as typed", () => {
    const data = mkdtempSync(path.join(tmpdir(), 'agy-data-'))
    mkdirSync(path.join(data, 'cache'))
    writeFileSync(path.join(data, 'cache', 'last_conversations.json'), JSON.stringify({ '/work/a': ID, '/work/b': 'not-an-id' }))
    expect(agyLastConversation('/work/a', data)).toBe(ID)
    expect(agyLastConversation('/work/b', data)).toBeNull()
    expect(agyLastConversation('/work/c', data)).toBeNull()
    expect(agyLastConversation('/work/a', path.join(data, 'missing'))).toBeNull()
  })
})

describe('agy model offer', () => {
  const OUTPUT = [
    'Fetching available models...',
    'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
    'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
    'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    ''
  ].join('\n')

  it('reads the slugs agy printed, skipping its banner', () => {
    expect(agySlugsOf(OUTPUT)).toEqual(['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-low', 'gemini-3.8-flash-medium', 'claude-sonnet-4-6'])
  })

  it('offers bare models with their own levels, in agy order of levels', () => {
    expect(agyOfferOf(agySlugsOf(OUTPUT))).toEqual({
      harness: 'agy',
      model: ['gemini-4-hydrogen', 'gemini-3.8-flash', 'claude-sonnet-4-6'],
      effort: ['low', 'high', 'xhigh'],
      effortFor: { 'gemini-3.8-flash': ['medium'], 'claude-sonnet-4-6': [] }
    })
    expect(agyOfferOf([])).toBeNull()
  })

  it('serves the cache, and refreshes only a missing or stale one in the background', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agy-models-'))
    const cacheFile = path.join(dir, 'agy-models.json')
    const refresh = vi.fn()
    expect(agyLaunchOffer({ cacheFile, refresh, now: () => 1000 })).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    writeFileSync(cacheFile, JSON.stringify({ at: 1000, slugs: ['gemini-4-hydrogen-high', '; rm -rf /'] }))
    expect(agyLaunchOffer({ cacheFile, refresh, now: () => 2000 })?.model).toEqual(['gemini-4-hydrogen'])
    expect(refresh).toHaveBeenCalledTimes(1)
    agyLaunchOffer({ cacheFile, refresh, now: () => 1000 + 7 * 60 * 60 * 1000 })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
