// SPOKEN REPLIES IN A DOUBAO-LIKE LOCAL VOICE (owner, 2026-11-03): "read the
// final reply aloud with a voice and pace like Doubao's, free, with what we
// already have, not by calling Doubao".
// The player (prompt/reply-voice.ts) against a fake audio element, a fake
// browser voice and a fake Mac; the phone's route (/api/speak) over HTTP.

import http from 'node:http'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { SpeakError } from '../src/main/local-voice'

interface Played {
  readonly kind: 'mac' | 'browser'
  readonly text: string
  readonly lang?: string
}

const played: Played[] = []
const blobText = new Map<string, string>()
let fetched: string[] = []
let langs: Array<string | undefined> = []

class FakeAudio {
  src = ''
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, cb: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(cb)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb)
  }
  play(): Promise<void> {
    const text = blobText.get(this.src)
    if (text !== undefined) {
      played.push({ kind: 'mac', text })
      setTimeout(() => this.listeners.get('ended')?.forEach((cb) => cb()), 1)
    }
    return Promise.resolve()
  }
  pause(): void {}
}

class FakeUtterance {
  lang = ''
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}

const synth = {
  queue: [] as FakeUtterance[],
  speak(u: FakeUtterance) {
    played.push({ kind: 'browser', text: u.text, ...(u.lang ? { lang: u.lang } : {}) })
    setTimeout(() => u.onend?.(), 1)
  },
  cancel: vi.fn()
}

const stub = (api: Record<string, unknown>): void => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = { cookrew: api, location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' }, addEventListener: () => undefined }
  g.Audio = FakeAudio
  g.SpeechSynthesisUtterance = FakeUtterance
  g.speechSynthesis = synth
  let n = 0
  ;(URL as unknown as Record<string, unknown>).createObjectURL = (blob: Blob & { said?: string }) => {
    n += 1
    const url = `blob:${n}`
    blobText.set(url, blob.said ?? '')
    return url
  }
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => undefined
}

/** Every argument the player handed the bridge, and every chunk it cancelled. */
let bridged: unknown[][] = []
let cancelled: string[] = []

const mac = (fail: (text: string) => boolean = () => false, hold?: Promise<void>) => ({
  speakAvailable: async () => true,
  speakAudio: async (...args: unknown[]) => {
    bridged = [...bridged, args]
    const [text, lang] = args as [string, string | undefined]
    fetched = [...fetched, text]
    langs = [...langs, lang]
    if (fail(text)) throw new Error('voice down')
    if (hold) await hold
    return Object.assign(new Blob(['mp3']), { said: text })
  },
  speakCancel: (id: string) => {
    cancelled = [...cancelled, id]
  }
})

const load = async () => {
  vi.resetModules()
  return import('../src/renderer/src/prompt/reply-voice')
}

beforeEach(() => {
  played.length = 0
  fetched = []
  langs = []
  bridged = []
  cancelled = []
  blobText.clear()
})

describe('reading a reply', () => {
  it("in the Mac's voice, chunk by chunk, the markdown not read", async () => {
    stub(mac())
    const voice = await load()
    await voice.readAloud('**Done.** Fixed `voice.ts`.\n\n```ts\nconst x = 1\n```')
    expect(played).toEqual([{ kind: 'mac', text: 'Done. Fixed voice.ts.' }])
  })

  it('a long reply: every chunk, in order, the next fetched while one plays', async () => {
    stub(mac())
    const voice = await load()
    const reply = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    await voice.readAloud(reply)
    expect(played.length).toBeGreaterThan(2)
    expect(played.every((p) => p.kind === 'mac')).toBe(true)
    expect(played.map((p) => p.text).join(' ')).toBe(reply)
    expect(fetched).toEqual(played.map((p) => p.text))
  })

  it('no local voice on this Mac: the browser reads, Chinese as Chinese', async () => {
    stub({ speakAvailable: async () => false, speakAudio: async () => new Blob([]) })
    const voice = await load()
    await voice.readAloud('改好了，测试通过。')
    expect(played).toEqual([{ kind: 'browser', text: '改好了，测试通过。', lang: 'zh-CN' }])
  })

  it('a chunk the Mac cannot voice: the rest falls back to the browser', async () => {
    stub(mac((text) => text.startsWith('Second')))
    const voice = await load()
    const reply = 'First it all went quite well. Second it broke. Third came after.'
    await voice.readAloud(reply)
    expect(played).toEqual([
      { kind: 'mac', text: 'First it all went quite well.' },
      { kind: 'browser', text: 'Second it broke. Third came after.' }
    ])
  })

  it('reading flags while it plays; stopReading ends it at once', async () => {
    stub(mac())
    const voice = await load()
    const seen: boolean[] = []
    voice.onReading((r) => seen.push(r))
    const reading = voice.readAloud(Array.from({ length: 30 }, (_, i) => `Sentence ${i} is here.`).join(' '))
    expect(voice.isReading()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    voice.stopReading()
    await reading
    expect(voice.isReading()).toBe(false)
    expect(seen).toEqual([true, false])
    expect(played.length).toBeLessThan(3)
  })

  it('a new reply ends the one before it', async () => {
    stub(mac())
    const voice = await load()
    const first = voice.readAloud(Array.from({ length: 30 }, (_, i) => `Old ${i}.`).join(' '))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await voice.readAloud('New reply.')
    await first
    expect(played.at(-1)).toEqual({ kind: 'mac', text: 'New reply.' })
    expect(played.filter((p) => p.text.startsWith('Old')).length).toBeLessThan(2)
  })

  it('a browser voice that never ends is called over at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const mute = { speak: () => undefined, cancel: () => undefined }
      stub({ speakAvailable: async () => false })
      ;(globalThis as unknown as Record<string, unknown>).speechSynthesis = mute
      const voice = await load()
      const reading = voice.readAloud('Hello there.')
      await vi.advanceTimersByTimeAsync(voice.browserDeadlineMs(['Hello there.']) + 1)
      await reading
      expect(voice.isReading()).toBe(false)
    } finally {
      vi.useRealTimers()
      ;(globalThis as unknown as Record<string, unknown>).speechSynthesis = synth
    }
  })

  it('priming plays silence and speaks an empty line, but never over a reading', async () => {
    stub(mac())
    const voice = await load()
    voice.primeVoice()
    expect(voice.isPrimed()).toBe(true)
    expect(played.at(-1)).toEqual({ kind: 'browser', text: '' })
    played.length = 0
    vi.resetModules()
    const fresh = await load()
    const reading = fresh.readAloud(Array.from({ length: 10 }, (_, i) => `Line ${i}.`).join(' '))
    fresh.primeVoice()
    expect(fresh.isPrimed()).toBe(false)
    fresh.stopReading()
    await reading
  })

  it('one voice per reading: Chinese anywhere is the Chinese voice, else the English one', async () => {
    stub(mac())
    const voice = await load()
    await voice.readAloud('Merged it. 测试通过。')
    expect(new Set(langs)).toEqual(new Set(['zh']))
    langs = []
    await voice.readAloud('Merged it. Tests pass.')
    expect(new Set(langs)).toEqual(new Set(['en']))
  })

  it('hands the bridge strings only: Electron cannot carry an AbortSignal across it', async () => {
    stub(mac())
    const voice = await load()
    await voice.readAloud(Array.from({ length: 12 }, (_, i) => `Sentence ${i} is here.`).join(' '))
    expect(bridged.length).toBeGreaterThan(1)
    for (const args of bridged) for (const arg of args) expect(['string', 'undefined']).toContain(typeof arg)
    const ids = bridged.map((args) => args[2])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a stop cancels the chunk still being made, by its id', async () => {
    let release: () => void = () => undefined
    stub(mac(() => false, new Promise<void>((resolve) => { release = resolve })))
    const voice = await load()
    const reading = voice.readAloud('First part of it. Second part of it.')
    await new Promise((resolve) => setTimeout(resolve, 0))
    voice.stopReading()
    release()
    await reading
    expect(cancelled).toEqual([bridged[0][2]])
  })

  it('a bridge that throws before it answers falls back to the browser, never escapes', async () => {
    stub({
      speakAvailable: async () => true,
      speakAudio: () => {
        throw new TypeError('signal?.addEventListener is not a function')
      }
    })
    const voice = await load()
    await expect(voice.readAloud('Done. All good.')).resolves.toBeUndefined()
    expect(played).toEqual([{ kind: 'browser', text: 'Done. All good.' }])
  })

  it('only code: nothing is read', async () => {
    stub(mac())
    const voice = await load()
    await voice.readAloud('```\nls\n```')
    expect(played).toEqual([])
    expect(voice.isReading()).toBe(false)
  })
})

const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'

describe('/api/speak', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ...over } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const call = (port: number, init: { method?: string; token?: string; text?: unknown }) =>
    fetch(`http://127.0.0.1:${port}/api/speak`, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), 'content-type': 'application/json' },
      ...(init.method === 'POST' ? { body: JSON.stringify({ text: init.text }) } : {})
    })

  it('says whether the Mac has the voice', async () => {
    const port = await startApi({ speak: { available: () => true, speak: async () => ({ audio: new Uint8Array(), type: 'audio/mp4' }), stop: () => undefined, warm: () => undefined } })
    expect((await call(port, {})).status).toBe(401)
    expect(await (await call(port, { token: PAIRING })).json()).toEqual({ available: true })
    const bare = await startApi({})
    expect(await (await call(bare, { token: PAIRING })).json()).toEqual({ available: false })
  })

  it('answers the text as audio, in the voice its language asks for', async () => {
    const said: string[] = []
    const speak = {
      available: () => true,
      speak: async (text: string, _signal?: AbortSignal, lang?: string) => (said.push(`${lang}:${text}`), { audio: new Uint8Array([7, 8, 9]), type: 'audio/mp4' }),
      stop: () => undefined, warm: () => undefined
    }
    const port = await startApi({ speak })
    const response = await call(port, { method: 'POST', token: PAIRING, text: 'hello' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mp4')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9])
    expect(said).toEqual(['zh:hello'])
  })

  it('is a write: the read-only wall token may not spend the key', async () => {
    const port = await startApi({ speak: { available: () => true, speak: async () => ({ audio: new Uint8Array([1]), type: 'audio/mp4' }), stop: () => undefined, warm: () => undefined } })
    expect((await call(port, { method: 'POST', token: WALL, text: 'x' })).status).toBe(401)
  })

  it('hands the voice a signal that fires when the phone hangs up', async () => {
    let signal: AbortSignal | undefined
    let started: () => void = () => undefined
    const begun = new Promise<void>((resolve) => { started = resolve })
    const speak = {
      available: () => true,
      stop: () => undefined, warm: () => undefined,
      speak: (_text: string, s?: AbortSignal) => {
        signal = s
        started()
        return new Promise<{ audio: Uint8Array; type: string }>((_resolve, reject) => s?.addEventListener('abort', () => reject(new SpeakError('Cancelled', 499))))
      }
    }
    const port = await startApi({ speak })
    const controller = new AbortController()
    const pending = fetch(`http://127.0.0.1:${port}/api/speak`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PAIRING}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
      signal: controller.signal
    }).catch(() => null)
    await begun
    controller.abort()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(signal?.aborted).toBe(true)
  })

  it("503 with no voice; the voice's own refusal keeps its status", async () => {
    const none = await startApi({})
    expect((await call(none, { method: 'POST', token: PAIRING, text: 'x' })).status).toBe(503)
    const busy = {
      available: () => true,
      stop: () => undefined, warm: () => undefined,
      speak: async () => {
        throw new SpeakError('The voice is busy', 429)
      }
    }
    const port = await startApi({ speak: busy })
    const response = await call(port, { method: 'POST', token: PAIRING, text: 'x' })
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: 'The voice is busy' })
  })
})
