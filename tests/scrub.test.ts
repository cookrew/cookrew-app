// THE SCRUB replaces VALUES, never words.
import { describe, expect, it } from 'vitest'
import { createScrubber, REDACTED, scrubShapes } from '../src/main/scrub'

const SEALED = 'sk_live_51Hx9QxSEALEDVALUE0000'
const PAIRING = 'MIFTW2wBqL-oWlyGfl1SDahBqTz64ATM'
const GATEWAY = 'sk-magpie-9f8e7d6c5b4a3f2e1d0c9b8a'

const scrub = createScrubber({
  secrets: () => [SEALED],
  tokens: () => [PAIRING, GATEWAY, null, undefined],
  env: { OPENAI_API_KEY: 'oai-ENVVALUE-123456', HOME: '/Users/x', GITHUB_TOKEN: 'ghtok-ENVVALUE-7890', SHORT_KEY: 'abc' }
})

describe('scrub', () => {
  it('replaces a sealed value wherever it appears', () => {
    expect(scrub(`stripe says ${SEALED} is live`)).toBe(`stripe says ${REDACTED} is live`)
  })
  it('replaces the pairing token and the gateway key', () => {
    expect(scrub(`open ?token=${PAIRING} now`)).toBe(`open ?token=${REDACTED} now`)
    expect(scrub(`bearer ${GATEWAY}`)).toBe(`bearer ${REDACTED}`)
  })
  it('replaces the values of env vars whose names say KEY / TOKEN / SECRET / PASSWORD — never the short ones', () => {
    expect(scrub('key oai-ENVVALUE-123456 and ghtok-ENVVALUE-7890')).toBe(`key ${REDACTED} and ${REDACTED}`)
    expect(scrub('abc is three letters')).toBe('abc is three letters')
    expect(scrub('/Users/x is a path')).toBe('/Users/x is a path')
  })
  it('replaces credentials by shape: sk-…, ghp_…, xox…, apikey_…, 48 chars of PADDED base64, a run after bearer/token=', () => {
    expect(scrubShapes('sk-proj-abcdefghijklmnop')).toBe(REDACTED)
    expect(scrubShapes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(REDACTED)
    expect(scrubShapes('xoxb-1234567890-abcdef')).toBe(REDACTED)
    expect(scrubShapes('apikey_abcdefghijkl')).toBe(REDACTED)
    expect(scrubShapes('b64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5MDE= end')).toBe(`b64 ${REDACTED} end`)
    expect(scrubShapes('Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef')).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(scrubShapes('?token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef&x=1')).toBe(`?token=${REDACTED}&x=1`)
  })
  it('round 2: a git SHA, a long path, a kebab branch and a bare hex run are prose, not credentials', () => {
    const sha = '3f2a9c1e7b6d5a4f3e2d1c0b9a8f7e6d5c4b3a2f'
    expect(sha).toHaveLength(40)
    expect(scrubShapes(`landed ${sha} on dev`)).toBe(`landed ${sha} on dev`)
    const long = '/Users/drej/workspace/cookrew-dev/.claude/worktrees/hp-security/src/main/scrub.ts'
    expect(long.length).toBeGreaterThan(60)
    expect(scrubShapes(long)).toBe(long)
    const branch = 'feat/route-sealed-secrets-note-keychain-opt-in-round-two'
    expect(branch.length).toBeGreaterThan(45)
    expect(scrubShapes(branch)).toBe(branch)
    expect(scrubShapes('hex 0123456789abcdef0123456789abcdef end')).toBe('hex 0123456789abcdef0123456789abcdef end')
  })
  it('never redacts the literal defaults, even when they are listed as values', () => {
    const s = createScrubber({ secrets: () => ['magpie-cookrew'], tokens: () => ['magpie-sous'], env: {} })
    expect(s('the local token is magpie-cookrew and Sous uses magpie-sous')).toBe('the local token is magpie-cookrew and Sous uses magpie-sous')
  })
  it('leaves words alone: "pairing token", "API key", a UUID, a path, a Chinese sentence', () => {
    expect(scrub('paste the pairing token and the API key here')).toBe('paste the pairing token and the API key here')
    const uuid = 'e03994f9-138d-80ff-9377-475cc59142b4'
    expect(scrub(`desktop ${uuid} note:${uuid}`)).toBe(`desktop ${uuid} note:${uuid}`)
    expect(scrub('/Users/drej/workspace/cookrew-dev/src/main/index.ts')).toBe('/Users/drej/workspace/cookrew-dev/src/main/index.ts')
    const zh = '把密钥密封进槽位之后，笔记正文里只剩下名字；手机通过 TLS 把值送到桌面端，经由 cookrew.dev 逐跳加密；本地代理用 cookrew secret exec 读取，每次读取都留有审计记录，served 会话永远拿不到。'.repeat(2)
    expect(zh.length).toBeGreaterThan(200)
    expect(scrub(zh)).toBe(zh)
  })
  it('is idempotent', () => {
    const once = scrub(`${SEALED} sk-abcdefghijklmnop ${PAIRING}`)
    expect(scrub(once)).toBe(once)
    expect(once).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`)
  })
  it('keeps a value table for a short TTL, and drops it the moment the store says so', () => {
    let values: string[] = []
    let reads = 0
    let clock = 1_000
    let signal: (() => void) | null = null
    const live = createScrubber({
      secrets: () => {
        reads += 1
        return values
      },
      env: {},
      now: () => clock,
      ttlMs: 2_000,
      onChange: (listener) => void (signal = listener)
    })
    expect(live('value-ABCDEFG1 here')).toBe('value-ABCDEFG1 here')
    expect(reads).toBe(1)
    // A burst of strings costs one table.
    for (let i = 0; i < 50; i += 1) live(`row ${i}`)
    expect(reads).toBe(1)
    // A seal: the store signals, the next string sees the new value.
    values = ['value-ABCDEFG1']
    signal!()
    expect(live('value-ABCDEFG1 here')).toBe(`${REDACTED} here`)
    expect(reads).toBe(2)
    // Without a signal the table still ages out.
    values = []
    clock += 2_001
    expect(live('value-ABCDEFG1 here')).toBe('value-ABCDEFG1 here')
    expect(reads).toBe(3)
    live.invalidate()
    live('x')
    expect(reads).toBe(4)
  })
  it('200 rows × 3 reasons scrub in under 20 ms with 10 sealed secrets', () => {
    const secrets = Array.from({ length: 10 }, (_, i) => `sk_live_SEALED_${i}_${'x'.repeat(24)}`)
    const s = createScrubber({ secrets: () => secrets, tokens: () => [PAIRING, GATEWAY], env: { OPENAI_API_KEY: 'oai-ENVVALUE-123456' } })
    const rows = Array.from({ length: 200 }, (_, i) => ({
      reasons: [`waiting ${i} minutes for ${secrets[i % 10]}`, 'blocked downstream by Forge', `dispatch ${i} still open on feat/route-sealed-${i}`]
    }))
    s('warm')
    const t0 = performance.now()
    const out = rows.map((row) => ({ ...row, reasons: row.reasons.map(s) }))
    const ms = performance.now() - t0
    expect(out[7].reasons[0]).toBe(`waiting 7 minutes for ${REDACTED}`)
    expect(out[7].reasons[2]).toBe('dispatch 7 still open on feat/route-sealed-7')
    expect(ms).toBeLessThan(20)
  })
  it('an empty or non-string input comes back as it was', () => {
    expect(scrub('')).toBe('')
    expect(scrub(undefined as unknown as string)).toBeUndefined()
  })
})
