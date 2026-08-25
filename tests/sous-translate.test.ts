import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateBody } from '../src/main/sous-translate'
import { resetRemoteSousCache } from '../src/main/sous-remote-config'

/** Stand in for Ollama. `reply` is what /api/generate returns for each call. */
function ollama(reply: (prompt: string, call: number) => unknown): {
  calls: string[]
  systems: string[]
} {
  const calls: string[] = []
  const systems: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { prompt: string; system: string }
    calls.push(body.prompt)
    systems.push(body.system)
    const r = reply(body.prompt, calls.length)
    if (r instanceof Error) throw r
    if (typeof r === 'number') return { ok: false, status: r }
    return { ok: true, json: async () => ({ response: r }) }
  })
  return { calls, systems }
}

// Never read the developer's ~/.cookrew/sous.json: these are the LOCAL-path
// tests, and on a machine with a remote translator configured they would
// silently exercise the remote one instead.
process.env.COOKREW_SOUS_CONFIG = '/nonexistent/cookrew-sous-test.json'

beforeEach(() => resetRemoteSousCache())

afterEach(() => vi.unstubAllGlobals())

describe('translateBody', () => {
  it('returns the translated body and the language it was asked for', async () => {
    ollama(() => 'こんにちは')
    const result = await translateBody('Hello', 'ja')
    expect(result).toEqual({ ok: true, text: 'こんにちは', language: 'ja' })
  })

  it('refuses a language it does not offer rather than asking the model anyway', async () => {
    const { calls } = ollama(() => 'whatever')
    const result = await translateBody('Hello', 'klingon')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('asks for the English NAME of the language, not the endonym', async () => {
    const { systems } = ollama(() => 'x')
    await translateBody('Hello', 'zh-Hans')
    expect(systems[0]).toContain('Simplified Chinese')
    expect(systems[0]).not.toContain('简体中文')
  })

  /**
   * The instructions must not travel inside the thing being translated: that is
   * what let the model echo them back as a body on a long reply.
   */
  it('sends the body as the prompt and the rules as the system message', async () => {
    const { calls, systems } = ollama(() => 'x')
    await translateBody('The body text.', 'ja')
    expect(calls[0]).toBe('The body text.')
    expect(calls[0]).not.toMatch(/only the translation/i)
    expect(systems[0]).toMatch(/only the translation/i)
  })

  it('an empty body is a no-op, not a request', async () => {
    const { calls } = ollama(() => 'x')
    expect(await translateBody('   \n ', 'ja')).toEqual({ ok: true, text: '', language: 'ja' })
    expect(calls).toHaveLength(0)
  })

  it('sends a long body as several bounded pieces', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph number ${i} of the reply.`).join(
      '\n\n'
    )
    const { calls } = ollama(() => 'PIECE')
    const result = await translateBody(long, 'fr')
    expect(calls.length).toBeGreaterThan(1)
    expect(result.ok).toBe(true)
  })

  /**
   * The half-translated body is the failure worth engineering against: it
   * renders as a bad translation rather than a failed one, and the reader has
   * no seam to tell them which half is which.
   */
  it('fails the whole body when one piece fails, rather than returning half', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph number ${i} of the reply.`).join(
      '\n\n'
    )
    const { calls } = ollama((_p, call) => (call === 2 ? 500 : 'PIECE'))
    const result = await translateBody(long, 'fr')
    expect(result.ok).toBe(false)
    // and it stops asking once it knows the answer is unusable
    expect(calls).toHaveLength(2)
  })

  describe('says which thing went wrong, because each has a different fix', () => {
    it('404 means the model is not pulled, not that the server is missing', async () => {
      ollama(() => 404)
      expect(await translateBody('Hello', 'ja')).toEqual({ ok: false, failure: 'model-missing' })
    })

    it('a refused connection is unreachable', async () => {
      ollama(() => Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }))
      expect(await translateBody('Hello', 'ja')).toEqual({ ok: false, failure: 'unreachable' })
    })

    it('an abort is a timeout, not a missing server', async () => {
      ollama(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
      expect(await translateBody('Hello', 'ja')).toEqual({ ok: false, failure: 'timeout' })
    })

    it('an answer that is not a translation is unusable, not a success', async () => {
      ollama(() => '   ')
      expect(await translateBody('Hello', 'ja')).toEqual({ ok: false, failure: 'unusable-output' })
    })
  })

  it('keeps the paragraph break between two pieces of the same body', async () => {
    // Two paragraphs big enough that they cannot share a piece, so the seam
    // between requests is exactly where the blank line was.
    // Each fits a piece on its own (749 chars); together they do not (1500).
    const big = 'word '.repeat(150).trim()
    ollama(() => 'TRANSLATED')
    const result = await translateBody(`${big}\n\n${big}`, 'de')
    expect(result.ok && result.text).toBe('TRANSLATED\n\nTRANSLATED')
  })

  /**
   * Small paragraphs used to go one-per-request: a forty-paragraph reply meant
   * forty sequential round trips to a local model for two sentences each.
   */
  it('packs small paragraphs together instead of one request each', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
    const { calls } = ollama(() => 'PIECE')
    await translateBody(body, 'fr')
    expect(body.length).toBeLessThan(1200)
    expect(calls).toHaveLength(1)
  })

  it('carries a piece with no letters through untouched instead of asking about it', async () => {
    const { calls } = ollama(() => 'SHOULD NOT BE USED')
    const result = await translateBody('```\n---\n```', 'ja')
    expect(calls).toHaveLength(0)
    expect(result.ok && result.text).toBe('```\n---\n```')
  })
})
