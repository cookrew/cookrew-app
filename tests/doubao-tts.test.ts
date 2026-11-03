import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOUBAO_DEFAULT_RESOURCE,
  DOUBAO_DEFAULT_SPEAKER,
  DOUBAO_TTS_URL,
  SPEAK_REQUEST_MAX_CHARS,
  audioOf,
  createDoubaoVoice,
  doubaoEnvPath,
  doubaoRequest,
  loadDoubaoTts,
  synthesizeDoubao,
  type DoubaoTtsConfig
} from '../src/main/doubao-tts'

const roots: string[] = []

function root(): string {
  const base = path.join(tmpdir(), `cookrew-doubao-${process.pid}-${roots.length}`)
  roots.push(base)
  mkdirSync(base, { recursive: true })
  return base
}

function envFile(base: string, body: string, mode = 0o600): void {
  const file = doubaoEnvPath(base)
  writeFileSync(file, body, { mode })
  chmodSync(file, mode)
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

const b64 = (s: string): string => Buffer.from(s).toString('base64')
const CONFIG: DoubaoTtsConfig = { auth: { apiKey: 'k-1' }, resourceId: DOUBAO_DEFAULT_RESOURCE, speaker: DOUBAO_DEFAULT_SPEAKER, speechRate: 0 }

describe('the Doubao key lives in one 0600 file', () => {
  it('unconfigured is null, never an ambient env var', () => {
    const prior = process.env.DOUBAO_TTS_API_KEY
    process.env.DOUBAO_TTS_API_KEY = 'ambient-must-not-win'
    try {
      expect(loadDoubaoTts({ base: root() })).toBeNull()
    } finally {
      if (prior === undefined) delete process.env.DOUBAO_TTS_API_KEY
      else process.env.DOUBAO_TTS_API_KEY = prior
    }
  })

  it.skipIf(process.platform === 'win32')('an API key, with Doubao defaults for voice, model and pace', () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_API_KEY="abc"\n')
    expect(loadDoubaoTts({ base })).toEqual({
      auth: { apiKey: 'abc' },
      resourceId: 'seed-tts-2.0',
      speaker: 'zh_female_vv_uranus_bigtts',
      speechRate: 0
    })
  })

  it.skipIf(process.platform === 'win32')('the old console pair, a chosen voice, a clamped rate', () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_APP_ID=123\nDOUBAO_TTS_ACCESS_KEY=tok\nDOUBAO_TTS_SPEAKER=zh_female_xiaohe_uranus_bigtts\nDOUBAO_TTS_SPEECH_RATE=400\n')
    expect(loadDoubaoTts({ base })).toMatchObject({ auth: { appId: '123', accessKey: 'tok' }, speaker: 'zh_female_xiaohe_uranus_bigtts', speechRate: 100 })
  })

  it.skipIf(process.platform === 'win32')('a file others can read is refused, by path only', () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_API_KEY=secret-value\n', 0o644)
    const logs: string[] = []
    expect(loadDoubaoTts({ base, log: (m) => logs.push(m) })).toBeNull()
    expect(logs.join('\n')).toMatch(/chmod 600/)
    expect(logs.join('\n')).not.toContain('secret-value')
  })

  it.skipIf(process.platform === 'win32')('a half pair is not a key', () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_APP_ID=123\n')
    expect(loadDoubaoTts({ base, log: () => undefined })).toBeNull()
  })
})

describe('the request', () => {
  it('V3 unidirectional, API-key auth, mp3 at the voice\'s own pace', () => {
    const { url, init } = doubaoRequest(CONFIG, 'hello', 'req-1')
    expect(url).toBe(DOUBAO_TTS_URL)
    expect(init.headers).toMatchObject({ 'X-Api-Key': 'k-1', 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': 'req-1' })
    expect(JSON.parse(init.body)).toEqual({
      user: { uid: 'cookrew' },
      req_params: { text: 'hello', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 0 } }
    })
  })

  it('the old console pair goes in its own two headers', () => {
    const { init } = doubaoRequest({ ...CONFIG, auth: { appId: 'a', accessKey: 'b' } }, 'x', 'r')
    expect(init.headers).toMatchObject({ 'X-Api-App-Id': 'a', 'X-Api-Access-Key': 'b' })
    expect(init.headers).not.toHaveProperty('X-Api-Key')
  })
})

describe('the stream: audio frames joined, the server\'s refusal named', () => {
  it('JSON lines', () => {
    const body = [
      JSON.stringify({ code: 0, message: '', data: b64('AB') }),
      JSON.stringify({ code: 0, message: '', data: null, sentence: { text: 'x' } }),
      JSON.stringify({ code: 0, message: '', data: b64('CD') }),
      JSON.stringify({ code: 20000000, message: 'ok', data: null })
    ].join('\n')
    expect(audioOf(body).toString()).toBe('ABCD')
  })

  it('SSE frames and back-to-back objects too', () => {
    const sse = `event: 352\ndata: ${JSON.stringify({ code: 0, data: b64('A}{') })}\n\ndata: {"code":20000000,"message":"ok"}\n\n`
    expect(audioOf(sse).toString()).toBe('A}{')
    expect(audioOf(`{"code":0,"data":"${b64('X')}"}{"code":20000000}`).toString()).toBe('X')
  })

  it('an error code throws with the server\'s message', () => {
    expect(() => audioOf('{"code":45000000,"message":"speaker permission denied"}')).toThrow(/45000000.*speaker permission denied/)
  })

  it('a refusal wrapped in a header throws too', () => {
    expect(() => audioOf('{"header":{"code":45000010,"message":"Invalid X-Api-Key"}}')).toThrow(/45000010.*Invalid X-Api-Key/)
  })

  it('no audio at all throws', () => {
    expect(() => audioOf('{"code":20000000,"message":"ok"}')).toThrow(/no audio/)
  })
})

describe('synthesizeDoubao', () => {
  it('posts and returns the joined audio', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, init })
      return new Response(`{"code":0,"data":"${b64('mp3')}"}\n{"code":20000000}`, { status: 200 })
    }
    const audio = await synthesizeDoubao(CONFIG, 'hi', { fetchImpl })
    expect(audio.toString()).toBe('mp3')
    expect(seen[0].url).toBe(DOUBAO_TTS_URL)
    expect(seen[0].init.method).toBe('POST')
  })

  it('the real 401 shape: its message and code, not the raw JSON', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"header":{"reqid":"r","code":45000010,"message":"Invalid X-Api-Key"}}', { status: 401 })
    await expect(synthesizeDoubao(CONFIG, 'hi', { fetchImpl })).rejects.toThrow('Doubao TTS HTTP 401: Invalid X-Api-Key (45000010)')
  })

  it('an HTTP refusal is named with its status and log id, never the key', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"message":"invalid api key"}', { status: 401, headers: { 'X-Tt-Logid': 'LOG1' } })
    await expect(synthesizeDoubao(CONFIG, 'hi', { fetchImpl })).rejects.toThrow(/401.*invalid api key.*LOG1/)
    await expect(synthesizeDoubao(CONFIG, 'hi', { fetchImpl })).rejects.not.toThrow(/k-1/)
  })
})

describe('cancel and timeout', () => {
  const hanging: (url: string, init: RequestInit) => Promise<Response> = (_url, init) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))

  it('a cancelled chunk stops upstream and says so', async () => {
    const controller = new AbortController()
    const pending = synthesizeDoubao(CONFIG, 'hi', { fetchImpl: hanging, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
  })

  it('a timeout is a 504, the body read included', async () => {
    await expect(synthesizeDoubao(CONFIG, 'hi', { fetchImpl: hanging, timeoutMs: 20 })).rejects.toMatchObject({ status: 504 })
    const slowBody: (url: string, init: RequestInit) => Promise<Response> = async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }) as unknown as Response
    await expect(synthesizeDoubao(CONFIG, 'hi', { fetchImpl: slowBody, timeoutMs: 20 })).rejects.toMatchObject({ status: 504 })
  })
})

describe('createDoubaoVoice: what main lends the box', () => {
  it.skipIf(process.platform === 'win32')('available follows the file; speak checks the text it is handed', async () => {
    const base = root()
    const fetchImpl = async (): Promise<Response> => new Response(`{"code":0,"data":"${b64('ok')}"}`, { status: 200 })
    const voice = createDoubaoVoice({ base, fetchImpl, log: () => undefined })
    expect(voice.available()).toBe(false)
    await expect(voice.speak('hi')).rejects.toMatchObject({ status: 503 })
    envFile(base, 'DOUBAO_TTS_API_KEY=k\n')
    expect(voice.available()).toBe(true)
    expect(Buffer.from(await voice.speak('hi')).toString()).toBe('ok')
    await expect(voice.speak('   ')).rejects.toMatchObject({ status: 400 })
    await expect(voice.speak(42 as unknown as string)).rejects.toMatchObject({ status: 400 })
    await expect(voice.speak('x'.repeat(SPEAK_REQUEST_MAX_CHARS + 1))).rejects.toMatchObject({ status: 413 })
  })

  it.skipIf(process.platform === 'win32')('a cap on requests in flight, so the box cannot run up the bill', async () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_API_KEY=k\n')
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl = async (): Promise<Response> => {
      await gate
      return new Response(`{"code":0,"data":"${b64('ok')}"}`, { status: 200 })
    }
    const voice = createDoubaoVoice({ base, fetchImpl, maxInFlight: 2, log: () => undefined })
    const a = voice.speak('a')
    const b = voice.speak('b')
    await expect(voice.speak('c')).rejects.toMatchObject({ status: 429 })
    release()
    await Promise.all([a, b])
    expect(Buffer.from(await voice.speak('d')).toString()).toBe('ok')
  })

  it.skipIf(process.platform === 'win32')('a budget of characters a minute', async () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_API_KEY=k\n')
    let clock = 0
    const fetchImpl = async (): Promise<Response> => new Response(`{"code":0,"data":"${b64('ok')}"}`, { status: 200 })
    const voice = createDoubaoVoice({ base, fetchImpl, charsPerMinute: 10, now: () => clock, log: () => undefined })
    await voice.speak('12345')
    await voice.speak('67890')
    await expect(voice.speak('x')).rejects.toMatchObject({ status: 429 })
    clock = 60_001
    expect(Buffer.from(await voice.speak('x')).toString()).toBe('ok')
  })

  it.skipIf(process.platform === 'win32')('the signal reaches the request', async () => {
    const base = root()
    envFile(base, 'DOUBAO_TTS_API_KEY=k\n')
    let aborted = false
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted')))))
    const voice = createDoubaoVoice({ base, fetchImpl, log: () => undefined })
    const controller = new AbortController()
    const pending = voice.speak('hi', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
    expect(aborted).toBe(true)
  })
})
