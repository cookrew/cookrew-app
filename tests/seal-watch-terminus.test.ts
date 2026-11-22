// The Mac's answers to a watch's device hello (canvas-seal-terminus.ts): what each refusal says, and that a
// watch spending its own handshake limit spends nothing of everyone's.
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSealTerminus, type SealTerminus } from '../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { startCodeHandshake, startDeviceHandshake } from '../src/shared/seal2/handshake'
import { newDevice, verifyDevice } from './support/seal2-accounts'

const servers: Server[] = []
const terminuses: SealTerminus[] = []
afterEach(async () => {
  for (const terminus of terminuses.splice(0)) terminus.close()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

async function mac(held: (id: string) => Promise<ReturnType<typeof newDevice>['jwk'] | null> = async () => null) {
  const self = newDevice()
  const code = newConnectCode()
  const id = await connectCodeId(code)
  const terminus = createSealTerminus({
    codeFor: (asked) => (asked === id ? code : null),
    dial: () => ({ write: () => undefined, end: () => undefined, destroy: () => undefined }),
    device: { self: () => self.signer, verify: verifyDevice, trusted: async () => false, admits: () => false, keyOf: held }
  })
  terminuses.push(terminus)
  const server = createServer((request, response) => {
    const device = request.headers['x-test-device'] as string
    void terminus.handle(request, response, { device })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const hello = (body: unknown, device: string) =>
    fetch(`${origin}/~seal/hello`, { method: 'POST', headers: { 'x-test-device': device }, body: JSON.stringify(body) }).then(async (answer) => ({ status: answer.status, said: (await answer.json()) as { error?: string } }))
  return { self, code, hello }
}

const watchOf = () => {
  const key = newDevice()
  const id = randomUUID()
  return { id, signer: { ...key.signer, deviceId: id } }
}

describe('a watch\'s device hello', () => {
  it('a key not held for that id is "not let in"; to another machine, "not this machine"; a desktop\'s malformed hello stays malformed', async () => {
    const { self, hello } = await mac()
    const watch = watchOf()
    const started = await startDeviceHandshake({ self: watch.signer, to: self.id, verify: verifyDevice })
    expect(await hello(started.hello, watch.id)).toEqual({ status: 403, said: { error: 'not let in' } })
    const elsewhere = await startDeviceHandshake({ self: watch.signer, to: newDevice().id, verify: verifyDevice })
    expect((await hello(elsewhere.hello, watch.id)).said.error).toBe('not this machine')
    // A desktop's (an id made from its key) malformed hello is a malformed hello, not a watch waiting for words.
    const desktop = newDevice()
    const fromDesktop = await startDeviceHandshake({ self: desktop.signer, to: self.id, verify: verifyDevice })
    expect((await hello({ ...fromDesktop.hello, e: 'not-a-key' }, desktop.id)).status).toBe(400)
  })

  it('a watch over its own limit spends nothing of the handshake budget everyone shares', async () => {
    const { self, code, hello } = await mac()
    const watch = watchOf()
    const started = await startDeviceHandshake({ self: watch.signer, to: self.id, verify: verifyDevice })
    for (let n = 0; n < 150; n += 1) await hello(started.hello, watch.id)
    const phone = await startCodeHandshake(code, { allowV1: false })
    expect((await hello(phone.hello, randomUUID())).status).toBe(200)
  })

  it('a watch paired again with a new key, while the old one is let in, is "not let in" with the new one', async () => {
    const old = newDevice().jwk
    const { self, hello } = await mac(async () => old)
    const watch = watchOf()
    const started = await startDeviceHandshake({ self: watch.signer, to: self.id, verify: verifyDevice })
    expect(await hello(started.hello, watch.id)).toEqual({ status: 403, said: { error: 'not let in' } })
  })
})
