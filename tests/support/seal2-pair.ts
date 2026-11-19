// Two real cookrew-seal/2 connections joined in memory (the engine of seal-peers.ts,
// without the relay): for tests of what rides a stream, not of the carrier.
import { createRecordReader } from '../../src/shared/canvas-seal-wire'
import { acceptCodeHandshake, startCodeHandshake } from '../../src/shared/seal2/handshake'
import { createSeal2Connection, type Seal2Connection, type Seal2Stream } from '../../src/shared/seal2/connection'
import type { Seal2Session } from '../../src/shared/seal2/records'

export async function seal2Pair(onStream: (stream: Seal2Stream) => void): Promise<{ a: Seal2Connection; b: Seal2Connection; close(): void }> {
  const code = new Uint8Array(32).fill(9)
  const started = await startCodeHandshake(code, { allowV1: false })
  const accepted = await acceptCodeHandshake(code, started.hello)
  const done = await started.finish(accepted?.accept)
  if (!accepted || done?.version !== 2) throw new Error('no session')
  let a: Seal2Connection | null = null
  let b: Seal2Connection | null = null
  const line = (to: () => Seal2Connection) => {
    const reader = createRecordReader()
    return (wire: Uint8Array): void => {
      const records = reader.push(wire)
      setTimeout(() => void to().receive(records), 0)
    }
  }
  a = createSeal2Connection({ session: done.session as Seal2Session, role: 'initiator', send: line(() => b as Seal2Connection) })
  b = createSeal2Connection({ session: accepted.session, role: 'responder', send: line(() => a as Seal2Connection), onStream })
  return {
    a,
    b,
    close: () => {
      a?.close('test over')
      b?.close('test over')
    }
  }
}
