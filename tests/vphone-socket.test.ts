// ONE JSON OBJECT IN, ONE JSON LINE OUT, over the machine's Unix socket.
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocketGuest, vphoneSocketPath } from '../src/main/vphone-socket'

const dirs: string[] = []
const servers: net.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const serve = async (reply: (request: Record<string, unknown>) => unknown): Promise<string> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vphone-sock-'))
  dirs.push(dir)
  const file = path.join(dir, 'vphone.sock')
  const server = net.createServer((socket) => {
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
      if (!data.includes('\n')) return
      const answer = reply(JSON.parse(data.trim()) as Record<string, unknown>)
      socket.end(`${JSON.stringify(answer)}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(file, resolve))
  return file
}

describe('the socket guest', () => {
  it('calls an rpc method and hands back its result', async () => {
    const seen: unknown[] = []
    const file = await serve((request) => {
      seen.push(request)
      return { ok: true, result: { width: 1290, height: 2796 } }
    })
    const guest = createSocketGuest(file)
    expect(await guest.rpc('device.screen', {})).toEqual({ width: 1290, height: 2796 })
    expect(seen).toEqual([{ t: 'rpc', method: 'device.screen', params: {}, screen: false }])
  })

  it('pings', async () => {
    const file = await serve(() => ({ ok: true }))
    expect(await createSocketGuest(file).ping()).toBe(true)
  })

  it('throws the guest’s own sentence on a refusal', async () => {
    const file = await serve(() => ({ ok: false, error: 'guest not connected' }))
    await expect(createSocketGuest(file).rpc('apps.launch', { bundle_id: 'x' })).rejects.toThrow('guest not connected')
  })

  it('fails fast when the socket is not there, naming the machine', async () => {
    const guest = createSocketGuest('/nonexistent/dir/vphone.sock', { machine: 'myphone' })
    expect(await guest.ping()).toBe(false)
    await expect(guest.rpc('device.screen', {})).rejects.toThrow(/myphone/)
  })

  it('names the socket under the library the way vphone-cli lays it out', () => {
    expect(vphoneSocketPath('myphone', '/Users/x/.vphone/machines')).toBe('/Users/x/.vphone/machines/myphone/vphone.sock')
  })
})
