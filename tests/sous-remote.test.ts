import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateBody } from '../src/main/sous-translate'
import {
  localTranslateModel,
  remoteSous,
  remoteSousHost,
  resetRemoteSousCache
} from '../src/main/sous-remote-config'

const ENV = ['COOKREW_SOUS_TRANSLATE_URL', 'COOKREW_SOUS_TRANSLATE_KEY', 'COOKREW_SOUS_REMOTE_MODEL']

function configureRemote(): void {
  process.env.COOKREW_SOUS_TRANSLATE_URL = 'https://example.invalid/'
  process.env.COOKREW_SOUS_TRANSLATE_KEY = 'secret-key-value'
  process.env.COOKREW_SOUS_REMOTE_MODEL = 'qwen3.8-27b-q8'
  resetRemoteSousCache()
}

// The file on this machine must not decide what these assert.
process.env.COOKREW_SOUS_CONFIG = '/nonexistent/cookrew-sous-test.json'

beforeEach(() => resetRemoteSousCache())

afterEach(() => {
  for (const k of ENV) delete process.env[k]
  resetRemoteSousCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('choosing a backend', () => {
  it('is local when nothing is configured', () => {
    expect(remoteSous()).toBeNull()
    expect(remoteSousHost()).toBeNull()
  })

  /**
   * Half a configuration is a typo, and treating it as configured turns that
   * typo into a feature that fails on every click instead of one that quietly
   * stays local.
   */
  it('is local when the key is missing, rather than sending unauthorized requests', () => {
    process.env.COOKREW_SOUS_TRANSLATE_URL = 'https://example.invalid'
    process.env.COOKREW_SOUS_REMOTE_MODEL = 'm'
    resetRemoteSousCache()
    expect(remoteSous()).toBeNull()
  })

  it('is remote when url, key and model are all present', () => {
    configureRemote()
    expect(remoteSous()).toEqual({
      baseUrl: 'https://example.invalid',
      apiKey: 'secret-key-value',
      model: 'qwen3.8-27b-q8'
    })
  })

  it('exposes the host for the UI, and never the key', () => {
    configureRemote()
    expect(remoteSousHost()).toBe('example.invalid')
    expect(JSON.stringify(remoteSousHost())).not.toContain('secret-key-value')
  })
})

describe('the remote request', () => {
  it('posts to /v1/messages with the key in a header, not the body', async () => {
    configureRemote()
    interface Seen {
      url: string
      init: { headers: Record<string, string>; body: string }
    }
    let seen: Seen | null = null
    vi.stubGlobal('fetch', async (url: string, init: Seen['init']) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
    })
    await translateBody('Hello', 'ja')
    expect(seen!.url).toBe('https://example.invalid/v1/messages')
    expect(seen!.init.headers['x-api-key']).toBe('secret-key-value')
    expect(seen!.init.body).not.toContain('secret-key-value')
    const body = JSON.parse(seen!.init.body) as { model: string; messages: { content: string }[] }
    expect(body.model).toBe('qwen3.8-27b-q8')
    expect(body.messages[0].content).toBe('Hello')
  })

  it('takes the text block and leaves the thinking block out of the body', async () => {
    configureRemote()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'thinking', thinking: 'We need to translate this into Japanese.' },
          { type: 'text', text: 'こんにちは' }
        ]
      })
    }))
    expect(await translateBody('Hello', 'ja')).toEqual({
      ok: true,
      text: 'こんにちは',
      language: 'ja'
    })
  })

  it('sends a body in ONE request that the local path would have cut up', async () => {
    configureRemote()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'T' }] }) }
    })
    const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the reply.`).join('\n\n')
    expect(body.length).toBeGreaterThan(1200)
    await translateBody(body, 'ja')
    expect(calls).toBe(1)
  })

  describe('names the failure, because each has a different fix', () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'model-missing'],
      [429, 'rate-limited'],
      [500, 'unreachable']
    ]
    for (const [status, failure] of cases) {
      it(`${status} → ${failure}`, async () => {
        configureRemote()
        vi.stubGlobal('fetch', async () => ({ ok: false, status }))
        expect(await translateBody('Hello', 'ja')).toEqual({ ok: false, failure })
      })
    }
  })

  /**
   * A proxy that rejects a key often echoes the request back in its error body.
   * Logging that would put the key in the app's console and in any log anyone
   * pastes into an issue.
   */
  it('never writes the key to the console on failure', async () => {
    configureRemote()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }))
    await translateBody('Hello', 'ja')
    expect(errors.join('\n')).not.toContain('secret-key-value')
    expect(errors.join('\n')).toContain('401')
  })
})

describe('turning the hosted model off', () => {
  /**
   * The revert path. Disabling used to mean editing this file AND restarting
   * the app, because the configuration was read once per process — so the file
   * said local while the running app kept talking to the host.
   */
  it('a config file with no active translate block reads as local, with no restart', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'sous-'))
    const file = join(dir, 'sous.json')
    process.env.COOKREW_SOUS_CONFIG = file

    writeFileSync(
      file,
      JSON.stringify({ translate: { baseUrl: 'https://h.invalid', apiKey: 'k', model: 'm' } })
    )
    expect(remoteSous()).not.toBeNull()

    // Same process, no restart, no cache to clear: rename the block and the
    // very next call is local again.
    writeFileSync(
      file,
      JSON.stringify({
        translateDisabled: { baseUrl: 'https://h.invalid', apiKey: 'k', model: 'm' }
      })
    )
    expect(remoteSous()).toBeNull()
    expect(remoteSousHost()).toBeNull()
  })
})

describe('the local translation model', () => {
  /**
   * Titles and translations are different jobs. The titling model is 1.5b, and
   * on a body of more than one paragraph it translates one and drops the rest —
   * a shorter body with nothing to say a paragraph is missing. This is how a
   * machine asks for a bigger model for translation only.
   */
  it('comes from the config file, falling back to the titling model', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const file = join(mkdtempSync(join(tmpdir(), 'sous-')), 'sous.json')
    process.env.COOKREW_SOUS_CONFIG = file

    writeFileSync(file, JSON.stringify({}))
    expect(localTranslateModel('qwen2.5:1.5b')).toBe('qwen2.5:1.5b')

    writeFileSync(file, JSON.stringify({ localModel: 'qwen2.5:3b' }))
    expect(localTranslateModel('qwen2.5:1.5b')).toBe('qwen2.5:3b')

    // Blank is not a choice — it must not produce a request for model "".
    writeFileSync(file, JSON.stringify({ localModel: '   ' }))
    expect(localTranslateModel('qwen2.5:1.5b')).toBe('qwen2.5:1.5b')
  })

  it('an absent config file leaves the titling model in place', () => {
    process.env.COOKREW_SOUS_CONFIG = '/nonexistent/cookrew-sous-test.json'
    expect(localTranslateModel('qwen2.5:1.5b')).toBe('qwen2.5:1.5b')
  })
})
