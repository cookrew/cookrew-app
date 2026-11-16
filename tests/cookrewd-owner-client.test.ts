import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOwnerClient } from '../src/main/daemon/owner-client'
import { MAX_LINE, startOwnerLink, type OwnerDispatch } from '../src/main/daemon/owner-link'

/**
 * The owner's side of the owner link (src/main/daemon/owner-client.ts), wired
 * to the daemon's side (owner-link.ts) over two in-memory pipes: what the
 * Electron shell (src/main/shell) does with fd 3.
 */

function pair(dispatch: OwnerDispatch) {
  const toDaemon = new PassThrough()
  const toOwner = new PassThrough()
  const link = startOwnerLink(toDaemon, toOwner, dispatch, vi.fn())
  const client = createOwnerClient(toOwner, toDaemon, vi.fn())
  return { link, client, toDaemon, toOwner }
}

afterEach(() => vi.useRealTimers())

describe('owner client', () => {
  it('invokes and gets the handler\'s answer, byte arrays intact', async () => {
    const { client } = pair({
      invoke: (channel, args) => Promise.resolve({ channel, echo: args[0], bytes: new Uint8Array([7, 8]) }),
      send: vi.fn()
    })
    const answer = (await client.invoke('image:read', ['a.png'])) as { channel: string; echo: string; bytes: Uint8Array }
    expect(answer.channel).toBe('image:read')
    expect(answer.echo).toBe('a.png')
    expect([...answer.bytes]).toEqual([7, 8])
  })

  it('rejects with the handler\'s error', async () => {
    const { client } = pair({ invoke: () => Promise.reject(new Error('no handler for x:y')), send: vi.fn() })
    await expect(client.invoke('x:y')).rejects.toThrow('no handler for x:y')
  })

  it('sends, and receives the window\'s events', async () => {
    const send = vi.fn()
    const { client, link } = pair({ invoke: () => Promise.resolve(null), send })
    const heard = vi.fn()
    client.onEvent(heard)
    client.send('pty:input', ['t1', 'ls\r'])
    link.emit('pty:data:t1', ['out'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(send).toHaveBeenCalledWith('pty:input', ['t1', 'ls\r'])
    expect(heard).toHaveBeenCalledWith('pty:data:t1', ['out'])
  })

  it('fails what is waiting when the daemon goes, and refuses after', async () => {
    const { client, toOwner } = pair({ invoke: () => new Promise(() => undefined), send: vi.fn() })
    const waiting = client.invoke('slow')
    toOwner.end()
    await expect(waiting).rejects.toThrow(/closed/)
    await client.closed
    await expect(client.invoke('later')).rejects.toThrow(/closed/)
  })

  it('has no timeout of its own: a slow answer (a sign-in waiting on a person) still arrives', async () => {
    vi.useFakeTimers()
    let answer: (v: unknown) => void = () => undefined
    const { client } = pair({ invoke: () => new Promise((resolve) => (answer = resolve)), send: vi.fn() })
    const waiting = client.invoke('account:oauthStart')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    answer('signed in')
    await expect(waiting).resolves.toBe('signed in')
  })

  it('refuses a request too big for the link instead of sending it', async () => {
    const invoke = vi.fn(() => Promise.resolve(null))
    const { client } = pair({ invoke, send: vi.fn() })
    await expect(client.invoke('attach:save', [new Uint8Array(MAX_LINE)])).rejects.toThrow(/over/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('tells the daemon the window\'s lifecycle', async () => {
    const window = vi.fn()
    const { client } = pair({ invoke: () => Promise.resolve(null), send: vi.fn(), window })
    client.windowEvent('contents', 'did-start-navigation', [{ isMainFrame: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(window).toHaveBeenCalledWith('contents', 'did-start-navigation', [{ isMainFrame: true }])
  })

  it('reads frames split across chunks and several in one chunk', async () => {
    const { client, toOwner } = pair({ invoke: () => Promise.resolve(null), send: vi.fn() })
    const heard: string[] = []
    client.onEvent((channel) => heard.push(channel))
    const a = JSON.stringify({ t: 'event', channel: 'a', args: [] })
    const b = JSON.stringify({ t: 'event', channel: 'b', args: [] })
    toOwner.write(a.slice(0, 5))
    toOwner.write(`${a.slice(5)}\n${b}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(heard).toEqual(['a', 'b'])
  })
})

describe('the daemon\'s channel list', () => {
  it('answers $channels with what main handles and listens on, after boot', async () => {
    vi.resetModules()
    const shim = await import('../src/main/daemon/electron-shim')
    shim.ipcMain.handle('workspace:list', () => [])
    shim.ipcMain.handle('terminal:create', () => null)
    shim.ipcMain.on('pty:input', () => undefined)
    const main = new shim.BrowserWindow({ webPreferences: { preload: '/app/out/preload/index.cjs' } })
    await main.loadFile('/app/out/renderer/index.html')
    await expect(shim.ownerDispatch.invoke(shim.OWNER_CHANNELS, [])).resolves.toEqual({
      handle: ['terminal:create', 'workspace:list'],
      on: ['pty:input']
    })
    expect((main.webContents as unknown as { id: number }).id).toBe(1)
  })
})
