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
  it('replaces credentials by shape: sk-…, ghp_…, xox…, apikey_…, 48 chars of base64, 32 of hex', () => {
    expect(scrubShapes('sk-proj-abcdefghijklmnop')).toBe(REDACTED)
    expect(scrubShapes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(REDACTED)
    expect(scrubShapes('xoxb-1234567890-abcdef')).toBe(REDACTED)
    expect(scrubShapes('apikey_abcdefghijkl')).toBe(REDACTED)
    expect(scrubShapes('b64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5 end')).toBe(`b64 ${REDACTED} end`)
    expect(scrubShapes('hex 0123456789abcdef0123456789abcdef end')).toBe(`hex ${REDACTED} end`)
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
  it('reads the sealed values and tokens per call, never from a cache', () => {
    let values: string[] = []
    const live = createScrubber({ secrets: () => values, env: {} })
    expect(live('value-ABCDEFG1 here')).toBe('value-ABCDEFG1 here')
    values = ['value-ABCDEFG1']
    expect(live('value-ABCDEFG1 here')).toBe(`${REDACTED} here`)
  })
  it('an empty or non-string input comes back as it was', () => {
    expect(scrub('')).toBe('')
    expect(scrub(undefined as unknown as string)).toBeUndefined()
  })
})
