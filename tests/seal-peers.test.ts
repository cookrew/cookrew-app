import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSealPeers, SealPeerRefusedError } from '../src/main/seal-peers'
import { createSealPinStore } from '../src/main/seal-pins'
import { newDevice, verifyDevice } from './support/seal2-relay-world'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const B = '53ab5b71-1430-891d-a7ce-2e3d6f3856bc'

/** A dialler whose relay records every call and carries none. */
function dialler() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-peers-'))
  dirs.push(dir)
  const pins = createSealPinStore(path.join(dir, 'seal-pins.json'))
  const asked: string[] = []
  const me = newDevice()
  const peers = createSealPeers({
    self: () => me.signer,
    verify: verifyDevice,
    relayed: async (deviceId) => {
      asked.push(deviceId)
      throw new Error('no relay in this test')
    },
    pins,
    retryMs: 10
  })
  return { pins, asked, peers }
}

describe('a desktop the owner blocked is never dialled (seal-peers.ts)', () => {
  it('neither openStream nor fetch reaches the relay for it', async () => {
    const { pins, asked, peers } = dialler()
    pins.block(B)
    await expect(peers.openStream(B, 'http')).rejects.toBeInstanceOf(SealPeerRefusedError)
    await expect(peers.fetch(B, { method: 'GET', path: '/api/x' })).rejects.toBeInstanceOf(SealPeerRefusedError)
    expect(asked).toEqual([])
    peers.close()
  })

  it('a desktop not blocked is dialled; one blocked and then said to be the same is dialled again', async () => {
    const { pins, asked, peers } = dialler()
    await expect(peers.openStream(B, 'http')).rejects.toThrow(/no relay in this test/)
    expect(asked.length).toBeGreaterThan(0)
    pins.block(B)
    const before = asked.length
    await expect(peers.openStream(B, 'http')).rejects.toBeInstanceOf(SealPeerRefusedError)
    expect(asked.length).toBe(before)
    pins.pin(B)
    await expect(peers.openStream(B, 'http')).rejects.toThrow(/no relay in this test/)
    expect(asked.length).toBeGreaterThan(before)
    peers.close()
  })
})
