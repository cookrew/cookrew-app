import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SPEAK_REQUEST_MAX_CHARS, createLocalVoice, localVoiceInstalled, voiceNode } from '../src/main/local-voice'

const roots: string[] = []

/** A home with every file the voice needs; `skip` leaves one out. */
function home(skip?: string): string {
  const base = path.join(tmpdir(), `cookrew-local-voice-${process.pid}-${roots.length}`)
  roots.push(base)
  const files = {
    'kokoro-server.cjs': '',
    'kokoro-multi-lang-v1_1/model.onnx': '',
    'node_modules/sherpa-onnx-node/package.json': '{}',
    'runtime.json': JSON.stringify({ node: process.execPath })
  }
  for (const [file, body] of Object.entries(files)) {
    if (file === skip) continue
    mkdirSync(path.dirname(path.join(base, file)), { recursive: true })
    writeFileSync(path.join(base, file), body)
  }
  return base
}

afterEach(() => {
  for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true })
})

/** A fake voice process: records requests; `answer` replies to one. */
function fakeProcess(opts: { lateExit?: boolean } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const exit = (): void => void child.emit('exit', 0)
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    kill: () => ((child.killed = true), opts.lateExit ? setTimeout(exit, 10) : exit(), true)
  })
  const requests: Array<Record<string, unknown>> = []
  let buffer = ''
  stdin.on('data', (d) => {
    buffer += String(d)
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      requests.push(JSON.parse(buffer.slice(0, at)))
      buffer = buffer.slice(at + 1)
    }
  })
  const answer = (message: Record<string, unknown>): void => void stdout.write(`${JSON.stringify(message)}\n`)
  return { child, requests, answer }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const asWav = (s: string): string => Buffer.from(s).toString('base64')

describe('is the local voice installed', () => {
  it('only with the script, the model, the runtime and its node', () => {
    expect(localVoiceInstalled(home())).toBe(true)
    for (const missing of ['kokoro-server.cjs', 'kokoro-multi-lang-v1_1/model.onnx', 'node_modules/sherpa-onnx-node/package.json', 'runtime.json']) {
      expect(localVoiceInstalled(home(missing))).toBe(false)
    }
  })

  it('a node that is gone is no node', () => {
    const base = home()
    writeFileSync(path.join(base, 'runtime.json'), JSON.stringify({ node: '/nowhere/node' }))
    expect(voiceNode(base)).toBeNull()
    expect(localVoiceInstalled(base)).toBe(false)
  })
})

describe('createLocalVoice', () => {
  const setup = (over: { idleMs?: number; maxQueued?: number; chunkTimeoutMs?: number } = {}) => {
    const fake = fakeProcess()
    let spawned = 0
    const voice = createLocalVoice({
      home: home(),
      log: () => undefined,
      spawnImpl: () => ((spawned += 1), fake.child as never),
      encode: async (wav) => ({ audio: new Uint8Array([...wav, 9]), type: 'audio/mp4' }),
      ...over
    })
    return { voice, fake, spawned: () => spawned }
  }

  it('one process, started on the first chunk; the answer comes back encoded', async () => {
    const { voice, fake, spawned } = setup()
    expect(spawned()).toBe(0)
    const pending = voice.speak('你好', undefined, 'zh')
    await tick()
    expect(spawned()).toBe(1)
    expect(fake.requests[0]).toMatchObject({ text: '你好', lang: 'zh' })
    fake.answer({ id: fake.requests[0].id, ok: true, wav: asWav('AB') })
    const out = await pending
    expect(out.type).toBe('audio/mp4')
    expect(Buffer.from(out.audio).toString()).toBe('AB\t')
    void voice.speak('again')
    await tick()
    expect(spawned()).toBe(1)
  })

  it("the process's refusal is a 502 with its words", async () => {
    const { voice, fake } = setup()
    const pending = voice.speak('x')
    await tick()
    fake.answer({ id: fake.requests[0].id, ok: false, error: 'model broke' })
    await expect(pending).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/model broke/) })
  })

  it('a cancelled chunk is told to the process and rejects at once', async () => {
    const { voice, fake } = setup()
    const controller = new AbortController()
    const pending = voice.speak('x', controller.signal)
    await tick()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ status: 499 })
    await tick()
    expect(fake.requests[1]).toEqual({ cancel: fake.requests[0].id })
  })

  it('the process dying fails what it held; the next chunk starts a new one', async () => {
    const { voice, fake, spawned } = setup()
    const pending = voice.speak('x')
    await tick()
    fake.child.emit('exit', 1)
    await expect(pending).rejects.toMatchObject({ status: 503 })
    void voice.speak('y').catch(() => undefined)
    await tick()
    expect(spawned()).toBe(2)
  })

  it('checks the text, and caps what waits', async () => {
    const { voice } = setup({ maxQueued: 2 })
    await expect(voice.speak('  ')).rejects.toMatchObject({ status: 400 })
    await expect(voice.speak(7 as unknown as string)).rejects.toMatchObject({ status: 400 })
    await expect(voice.speak('x'.repeat(SPEAK_REQUEST_MAX_CHARS + 1))).rejects.toMatchObject({ status: 413 })
    void voice.speak('a').catch(() => undefined)
    void voice.speak('b').catch(() => undefined)
    await expect(voice.speak('c')).rejects.toMatchObject({ status: 429 })
  })

  it('not installed: 503, and nothing spawned', async () => {
    let spawned = 0
    const voice = createLocalVoice({ home: home('kokoro-server.cjs'), spawnImpl: () => ((spawned += 1), fakeProcess().child as never) })
    expect(voice.available()).toBe(false)
    await expect(voice.speak('x')).rejects.toMatchObject({ status: 503 })
    expect(spawned).toBe(0)
  })

  it('idle, the process is let go (its model is half a gigabyte)', async () => {
    const { voice, fake } = setup({ idleMs: 20 })
    const pending = voice.speak('x')
    await tick()
    fake.answer({ id: fake.requests[0].id, ok: true, wav: asWav('A') })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.child.killed).toBe(true)
  })

  it('a spawn that fails (error, no exit) fails its chunk, and the next one spawns again', async () => {
    const fakes = [fakeProcess(), fakeProcess()]
    let spawned = 0
    const voice = createLocalVoice({ home: home(), log: () => undefined, spawnImpl: () => fakes[spawned++].child as never })
    const pending = voice.speak('x')
    await tick()
    fakes[0].child.emit('error', new Error('spawn EACCES'))
    await expect(pending).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/EACCES/) })
    void voice.speak('y').catch(() => undefined)
    await tick()
    expect(spawned).toBe(2)
    expect(fakes[1].requests[0]).toMatchObject({ text: 'y' })
  })

  it("a write racing the child's death (EPIPE) is logged, never thrown", async () => {
    const { voice, fake } = setup()
    void voice.speak('x').catch(() => undefined)
    await tick()
    expect(() => fake.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
  })

  it("a killed process's late exit does not fail the newer process's chunk", async () => {
    const fakes = [fakeProcess({ lateExit: true }), fakeProcess()]
    let spawned = 0
    const voice = createLocalVoice({ home: home(), idleMs: 1, log: () => undefined, encode: async (wav) => ({ audio: new Uint8Array([...wav, 9]), type: 'audio/mp4' }), spawnImpl: () => fakes[spawned++].child as never })
    const first = voice.speak('a')
    await tick()
    fakes[0].answer({ id: fakes[0].requests[0].id, ok: true, wav: asWav('A') })
    await first
    await new Promise((resolve) => setTimeout(resolve, 3))
    expect(fakes[0].child.killed).toBe(true)
    const second = voice.speak('b')
    await new Promise((resolve) => setTimeout(resolve, 20))
    fakes[1].answer({ id: fakes[1].requests[0].id, ok: true, wav: asWav('B') })
    expect(Buffer.from((await second).audio).toString()).toBe('B\t')
  })

  it('a chunk that never comes back gives up with a 504', async () => {
    const { voice, fake } = setup({ chunkTimeoutMs: 20 })
    const pending = voice.speak('x')
    await expect(pending).rejects.toMatchObject({ status: 504 })
    await tick()
    expect(fake.requests.at(-1)).toEqual({ cancel: fake.requests[0].id })
  })
})
