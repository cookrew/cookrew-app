import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeLine, encodeFrame, EVENT_BACKLOG, MAX_IN_FLIGHT, MAX_LINE, readOwnerFrame, startOwnerLink, type OwnerDispatch } from '../src/main/daemon/owner-link'
import { inspectorProblems } from '../src/main/daemon/no-inspector'
import { isOwnerPage, isOwnerSender } from '../src/main/owner-grant'

/**
 * cookrewd's owner link (src/main/daemon/owner-link.ts) and the owner window
 * the shim makes for it: the renderer's IPC over a pipe, with main's own owner
 * checks holding for the owner and for nothing else.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

function harness(dispatch: OwnerDispatch) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: unknown[] = []
  let buffered = ''
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buffered += chunk
    let at = buffered.indexOf('\n')
    while (at !== -1) {
      lines.push(decodeLine(buffered.slice(0, at)))
      buffered = buffered.slice(at + 1)
      at = buffered.indexOf('\n')
    }
  })
  const log = vi.fn()
  const link = startOwnerLink(input, output, dispatch, log)
  const say = (frame: unknown) => input.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)
  return { input, link, lines, log, say }
}

describe('owner link framing', () => {
  it('carries byte arrays as $bytes and back', () => {
    const line = encodeFrame({ t: 'result', id: 1, ok: true, value: { audio: new Uint8Array([1, 2, 255]), buf: Buffer.from('hi') } })
    expect(line).not.toContain('"type":"Buffer"')
    const back = decodeLine(line) as { value: { audio: Uint8Array; buf: Uint8Array } }
    expect([...back.value.audio]).toEqual([1, 2, 255])
    expect(Buffer.from(back.value.buf).toString()).toBe('hi')
  })

  it('never lets content pass for bytes, in either direction', () => {
    const content = { note: { $bytes: 'aGk=' }, buf: { type: 'Buffer', data: [1, 2] }, $weird: 1 }
    const back = decodeLine(encodeFrame({ t: 'event', channel: 'note', args: [content] })) as { args: unknown[] }
    expect(back.args[0]).toEqual(content)
  })

  it('refuses what JSON cannot carry instead of crashing', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => encodeFrame({ t: 'event', channel: 'x', args: [cycle] })).toThrow()
    expect(() => encodeFrame({ t: 'event', channel: 'x', args: [10n] })).toThrow(/BigInt/)
  })

  it('reads only well-formed frames', () => {
    expect(readOwnerFrame('{"t":"invoke","id":3,"channel":"a:b","args":[1]}')).toEqual({ t: 'invoke', id: 3, channel: 'a:b', args: [1] })
    expect(readOwnerFrame('{"t":"send","channel":"pty:input","args":["t","x"]}')).toEqual({ t: 'send', channel: 'pty:input', args: ['t', 'x'] })
    for (const bad of ['nope', '{}', '{"t":"invoke","channel":"a","args":[]}', '{"t":"invoke","id":1.5,"channel":"a","args":[]}', '{"t":"send","channel":"","args":[]}', '{"t":"other","channel":"a","args":[]}', '{"t":"send","channel":"a","args":{}}']) {
      expect(readOwnerFrame(bad)).toBeNull()
    }
  })
})

describe('owner link', () => {
  it('answers each invoke by its id, concurrently and in completion order', async () => {
    let releaseSlow: (v: unknown) => void = () => undefined
    const dispatch: OwnerDispatch = {
      invoke: (channel) => (channel === 'slow' ? new Promise((resolve) => (releaseSlow = resolve)) : Promise.resolve(`fast:${channel}`)),
      send: vi.fn()
    }
    const { lines, say } = harness(dispatch)
    say({ t: 'invoke', id: 1, channel: 'slow', args: [] })
    say({ t: 'invoke', id: 2, channel: 'quick', args: [] })
    await tick()
    releaseSlow('done')
    await tick()
    expect(lines).toEqual([
      { t: 'result', id: 2, ok: true, value: 'fast:quick' },
      { t: 'result', id: 1, ok: true, value: 'done' }
    ])
  })

  it('reports a failing handler as an error result, and undefined as null', async () => {
    const dispatch: OwnerDispatch = {
      invoke: (channel) => (channel === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined)),
      send: vi.fn()
    }
    const { lines, say } = harness(dispatch)
    say({ t: 'invoke', id: 7, channel: 'bad', args: [] })
    say({ t: 'invoke', id: 8, channel: 'void', args: [] })
    await tick()
    expect(lines).toContainEqual({ t: 'result', id: 7, ok: false, error: 'boom' })
    expect(lines).toContainEqual({ t: 'result', id: 8, ok: true, value: null })
  })

  it('passes sends through, survives a bad line, and joins lines split across chunks', async () => {
    const send = vi.fn()
    const { input, log, say } = harness({ invoke: () => Promise.resolve(null), send })
    say('not json')
    input.write('{"t":"send","channel":"pty:in')
    input.write('put","args":["t1","ls\\r"]}\n')
    await tick()
    expect(log).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('pty:input', ['t1', 'ls\r'])
  })

  it('emits window events to the owner, and stops after the pipe ends', async () => {
    const { input, link, lines } = harness({ invoke: () => Promise.resolve(null), send: vi.fn() })
    expect(link.emit('pty:data:t1', ['abc'])).toBe(true)
    await tick()
    expect(lines).toEqual([{ t: 'event', channel: 'pty:data:t1', args: ['abc'] }])
    input.end()
    await link.closed
    expect(link.emit('pty:data:t1', ['late'])).toBe(false)
  })

  it('answers an unserializable result with an error rather than dying', async () => {
    const { lines, say } = harness({ invoke: () => Promise.resolve({ big: 1n }), send: vi.fn() })
    say({ t: 'invoke', id: 4, channel: 'x', args: [] })
    await tick()
    expect(lines).toEqual([{ t: 'result', id: 4, ok: false, error: expect.stringMatching(/cannot cross/) }])
  })

  it('answers an over-long result with an error, so the owner\'s client never has to close', async () => {
    const { lines, say } = harness({ invoke: () => Promise.resolve(new Uint8Array(MAX_LINE)), send: vi.fn() })
    say({ t: 'invoke', id: 9, channel: 'image:read', args: [] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(lines).toEqual([{ t: 'result', id: 9, ok: false, error: expect.stringMatching(/over/) }])
  })

  it('refuses requests beyond the in-flight cap', async () => {
    const { lines, say } = harness({ invoke: () => new Promise(() => undefined), send: vi.fn() })
    for (let id = 1; id <= MAX_IN_FLIGHT + 1; id += 1) say({ t: 'invoke', id, channel: 'hang', args: [] })
    await tick()
    expect(lines).toEqual([{ t: 'result', id: MAX_IN_FLIGHT + 1, ok: false, error: expect.stringMatching(/too many/) }])
  })

  it('drops window events, never results, when the owner stops reading', async () => {
    const input = new PassThrough()
    const output = new PassThrough({ highWaterMark: 1 })
    let release: (v: unknown) => void = () => undefined
    const log = vi.fn()
    const link = startOwnerLink(input, output, { invoke: () => new Promise((r) => (release = r)), send: vi.fn() }, log)
    input.write(`${JSON.stringify({ t: 'invoke', id: 1, channel: 'x', args: [] })}\n`)
    const chunk = 'x'.repeat(8 * 1024 * 1024)
    let sent = 0
    while (link.emit('pty:data:t1', [chunk])) sent += 1
    expect(sent).toBeLessThanOrEqual(EVENT_BACKLOG / chunk.length + 1)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/owner is behind/))
    release('answer')
    await tick()
    // The owner reads again: everything queued, the result included, comes out.
    let written = ''
    output.on('data', (piece: Buffer) => (written += piece.toString()))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(written).toContain('{"t":"result","id":1,"ok":true,"value":"answer"}')
  })

  it('writes an essential event however far behind the owner is', () => {
    const input = new PassThrough()
    const output = new PassThrough({ highWaterMark: 1 })
    const link = startOwnerLink(input, output, { invoke: () => Promise.resolve(null), send: vi.fn() }, vi.fn())
    const chunk = 'x'.repeat(8 * 1024 * 1024)
    while (link.emit('pty:data:t1', [chunk])) {
      // fill the backlog past EVENT_BACKLOG
    }
    expect(link.emit('$port:message', [1, 'frame'])).toBe(false)
    expect(link.emit('$port:open', [1, 'browser-stream:port', {}], true)).toBe(true)
  })

  it('reads lines byte by byte, multi-byte characters split across chunks included', async () => {
    const send = vi.fn()
    const { input } = harness({ invoke: () => Promise.resolve(null), send })
    const line = Buffer.from(`${JSON.stringify({ t: 'send', channel: 'pty:input', args: ['t1', '你好'] })}\n`)
    for (const byte of line) input.write(Buffer.from([byte]))
    await tick()
    expect(send).toHaveBeenCalledWith('pty:input', ['t1', '你好'])
  })

  it('skips a line over the limit and carries on with the next', async () => {
    const send = vi.fn()
    const { input, link, log } = harness({ invoke: () => Promise.resolve(null), send })
    input.write('x'.repeat(MAX_LINE + 1))
    input.write(`yyy\n${JSON.stringify({ t: 'send', channel: 'after', args: [] })}\n`)
    await tick()
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped/))
    expect(send).toHaveBeenCalledWith('after', [])
    expect(link.emit('still', [])).toBe(true)
  })

  it('reads window frames and refuses malformed ones', () => {
    expect(readOwnerFrame('{"t":"window","target":"window","name":"focus","args":[{}]}')).toEqual({ t: 'window', target: 'window', name: 'focus', args: [{}] })
    expect(readOwnerFrame('{"t":"window","target":"elsewhere","name":"focus","args":[]}')).toBeNull()
  })
})

describe('the owner window in the shim', () => {
  const load = async () => {
    vi.resetModules()
    return import('../src/main/daemon/electron-shim')
  }
  afterEach(() => vi.restoreAllMocks())

  it('makes only the app-preload window the owner, and only its events reach the owner', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { BrowserWindow, connectOwner } = await load()
    const sink = vi.fn()
    connectOwner(sink)
    const capture = new BrowserWindow({ show: false, webPreferences: { preload: '/app/out/main/capture-preload.js' } })
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    expect(capture.isDestroyed()).toBe(true)
    expect(main.isDestroyed()).toBe(false)
    capture.webContents.send('nope', 1)
    main.webContents.send('workspace:state', { id: 'w1' })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith('workspace:state', [{ id: 'w1' }])
    // A second app-preload window does not become a second owner.
    expect(new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } }).isDestroyed()).toBe(true)
  })

  it('hands handlers an event that passes main\'s own owner checks', async () => {
    const { BrowserWindow, ipcMain, ownerDispatch } = await load()
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    // Main's ownerPageUrl() is pathToFileURL of an absolute path on this host:
    // file:///app/... here, file:///D:/app/... on Windows, where a rooted path
    // takes the current drive.
    const page = path.resolve('/app/out/renderer/index.html')
    await main.loadFile(page)
    let checked: boolean | null = null
    ipcMain.handle('launch-settings:status', (event: unknown) => {
      const e = event as { sender: unknown; senderFrame: { parent: unknown; url?: string } }
      checked = isOwnerSender(e.sender, e.senderFrame, main.webContents) && isOwnerPage(e.senderFrame.url, pathToFileURL(page).href)
      return { ok: true }
    })
    await expect(ownerDispatch.invoke('launch-settings:status', [])).resolves.toEqual({ ok: true })
    expect(checked).toBe(true)
  })

  it('holds sends until boot is done, and rejects an unknown channel once it is', async () => {
    const { BrowserWindow, ipcMain, ownerDispatch } = await load()
    const heard = vi.fn()
    ipcMain.on('pty:input', heard)
    ownerDispatch.send('pty:input', ['t1', 'early'])
    expect(heard).not.toHaveBeenCalled()
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    await main.loadFile('/app/out/renderer/index.html')
    await tick()
    expect(heard).toHaveBeenCalledWith(expect.anything(), 't1', 'early')
    await expect(ownerDispatch.invoke('no:such', [])).rejects.toThrow(/no handler/)
  })

  it('hands the owner the window events sent before it connected', async () => {
    const { BrowserWindow, connectOwner } = await load()
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    main.webContents.send('workspace:state', { id: 'w0' })
    const sink = vi.fn()
    connectOwner(sink)
    expect(sink).toHaveBeenCalledWith('workspace:state', [{ id: 'w0' }])
  })

  it('re-emits only allowlisted window events on the owner window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { BrowserWindow, ownerDispatch } = await load()
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    const focused = vi.fn()
    const navigated = vi.fn()
    const typed = vi.fn()
    main.on('focus', focused)
    main.webContents.on('did-start-navigation', navigated)
    main.webContents.on('before-input-event', typed)
    ownerDispatch.window('window', 'focus', [{}])
    ownerDispatch.window('contents', 'did-start-navigation', [{ isMainFrame: true }])
    ownerDispatch.window('contents', 'before-input-event', [{}, { key: 'q', meta: true }])
    expect(focused).toHaveBeenCalledOnce()
    expect(navigated).toHaveBeenCalledWith({ isMainFrame: true })
    expect(typed).not.toHaveBeenCalled()
  })

  it('reaches ipcMain.on listeners with the owner event and the arguments', async () => {
    const { BrowserWindow, ipcMain, ownerDispatch } = await load()
    const main = new BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    await main.loadURL('http://localhost:5173/')
    const heard = vi.fn()
    ipcMain.on('pty:input', heard)
    ownerDispatch.send('pty:input', ['t1', 'ls\r'])
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ sender: main.webContents }), 't1', 'ls\r')
  })
})

describe('no inspector into the daemon', () => {
  const quiet = { env: {}, execArgv: [], inspectorUrl: undefined }
  it('is fine when nothing asks for one', () => {
    expect(inspectorProblems(quiet)).toEqual([])
  })
  it('refuses an open inspector, an inspect flag, or NODE_OPTIONS asking for one', () => {
    expect(inspectorProblems({ ...quiet, inspectorUrl: 'ws://127.0.0.1:9229/x' })).toHaveLength(1)
    expect(inspectorProblems({ ...quiet, execArgv: ['--inspect-brk=0'] })).toHaveLength(1)
    expect(inspectorProblems({ ...quiet, env: { NODE_OPTIONS: '--max-old-space-size=4096 --inspect' } })).toHaveLength(1)
    expect(inspectorProblems({ ...quiet, env: { NODE_OPTIONS: '--max-old-space-size=4096' } })).toEqual([])
  })
  it('takes SIGUSR1 once imported, so Node does not open an inspector on it', () => {
    expect(process.listenerCount('SIGUSR1')).toBeGreaterThan(0)
  })
})
