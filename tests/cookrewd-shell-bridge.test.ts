import { describe, expect, it, vi } from 'vitest'
import { HeldEvents, isOwnerCall, NOT_OWNER, registerBridge, type CallerEvent, type IpcLike } from '../src/main/shell/bridge'

/**
 * The Electron shell's bridge (src/main/shell/bridge.ts): where the owner
 * boundary lives once the daemon treats its link as the owner.
 */

const OWNER_URL = 'file:///app/out/renderer/index.html'
const owner = { id: 1 }
const ownerCall: CallerEvent = { sender: owner, senderFrame: { parent: null, url: OWNER_URL } }

describe('isOwnerCall', () => {
  it('is the owner window\'s top frame on the owner page, and nothing else', () => {
    expect(isOwnerCall(ownerCall, owner, OWNER_URL)).toBe(true)
    // a webview guest or any other webContents
    expect(isOwnerCall({ ...ownerCall, sender: { id: 2 } }, owner, OWNER_URL)).toBe(false)
    // a sub-frame of the owner window
    expect(isOwnerCall({ ...ownerCall, senderFrame: { parent: {}, url: OWNER_URL } }, owner, OWNER_URL)).toBe(false)
    // a stranger's page that ended up in the top frame
    expect(isOwnerCall({ ...ownerCall, senderFrame: { parent: null, url: 'https://evil.example/' } }, owner, OWNER_URL)).toBe(false)
    // no frame to prove anything with, or no owner window at all
    expect(isOwnerCall({ sender: owner, senderFrame: null }, owner, OWNER_URL)).toBe(false)
    expect(isOwnerCall(ownerCall, null, OWNER_URL)).toBe(false)
  })
})

function fakeIpc() {
  const handlers = new Map<string, (event: CallerEvent, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (event: CallerEvent, ...args: unknown[]) => void>()
  const ipc: IpcLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: (channel, listener) => void listeners.set(channel, listener)
  }
  return { ipc, handlers, listeners }
}

describe('registerBridge', () => {
  const setup = () => {
    const { ipc, handlers, listeners } = fakeIpc()
    const client = { invoke: vi.fn(async (channel: string, args: readonly unknown[]) => ({ from: 'daemon', channel, args })), send: vi.fn() }
    const local = vi.fn(() => '/picked')
    const quit = vi.fn()
    const counts = registerBridge({
      ipc,
      client,
      channels: { handle: ['workspace:list', 'dir:pick'], on: ['pty:input'] },
      localHandlers: { 'dir:pick': local },
      localSends: { 'app:quit': quit },
      isOwner: (event) => isOwnerCall(event, owner, OWNER_URL),
      log: vi.fn()
    })
    return { handlers, listeners, client, local, quit, counts }
  }

  it('forwards the owner\'s calls, answers local ones here, and counts each channel once', async () => {
    const { handlers, listeners, client, local, quit, counts } = setup()
    expect(counts).toEqual({ handle: 2, on: 2 })
    await expect(handlers.get('workspace:list')!(ownerCall, 1)).resolves.toEqual({ from: 'daemon', channel: 'workspace:list', args: [1] })
    expect(handlers.get('dir:pick')!(ownerCall)).toBe('/picked')
    expect(client.invoke).toHaveBeenCalledTimes(1)
    expect(local).toHaveBeenCalledOnce()
    listeners.get('pty:input')!(ownerCall, 't1', 'ls\r')
    listeners.get('app:quit')!(ownerCall)
    expect(client.send).toHaveBeenCalledWith('pty:input', ['t1', 'ls\r'])
    expect(quit).toHaveBeenCalledOnce()
  })

  it('refuses any other caller before anything crosses to the daemon', async () => {
    const { handlers, listeners, client, local, quit } = setup()
    const stranger: CallerEvent = { sender: owner, senderFrame: { parent: null, url: 'https://evil.example/' } }
    expect(() => handlers.get('workspace:list')!(stranger)).toThrow(NOT_OWNER)
    expect(() => handlers.get('dir:pick')!(stranger)).toThrow(NOT_OWNER)
    listeners.get('pty:input')!(stranger, 't1', 'rm -rf ~\r')
    listeners.get('app:quit')!(stranger)
    expect(client.invoke).not.toHaveBeenCalled()
    expect(client.send).not.toHaveBeenCalled()
    expect(local).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('HeldEvents', () => {
  it('holds events until the page loads, then delivers them in order and the rest directly', () => {
    const held = new HeldEvents()
    held.push('workspace:state', [1])
    held.push('pty:data:t1', ['a'])
    const delivered: unknown[] = []
    expect(held.open((channel, args) => delivered.push([channel, ...args]))).toBe(0)
    held.push('pty:data:t1', ['b'])
    expect(delivered).toEqual([['workspace:state', 1], ['pty:data:t1', 'a'], ['pty:data:t1', 'b']])
  })

  it('is bounded, and says how many it dropped', () => {
    const held = new HeldEvents(2)
    for (let i = 0; i < 5; i += 1) held.push('e', [i])
    const delivered: unknown[] = []
    expect(held.open((_c, args) => delivered.push(args[0]))).toBe(3)
    expect(delivered).toEqual([0, 1])
  })
})
