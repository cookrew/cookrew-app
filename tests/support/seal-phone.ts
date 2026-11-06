// A phone, for tests: a real client of the sealed session's wire, over real HTTP.
import { expect } from 'vitest'
import { startHandshake, type SealRecord, type SealSession } from '../../src/shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, type Inbox, type SealFrame } from '../../src/shared/canvas-seal-wire'

/** A phone: handshake, a reader on the down stream, records up. */
export class SealPhone {
  frames: SealFrame[] = []
  session: SealSession | null = null
  inbox: Inbox | null = null
  private stream: AbortController | null = null

  constructor(private readonly origin: string, private readonly code: Uint8Array, private readonly headers: Record<string, string> = {}) {}

  async connect(): Promise<void> {
    const started = await startHandshake(this.code)
    const hello = await fetch(`${this.origin}/~seal/hello`, { method: 'POST', headers: this.headers, body: JSON.stringify(started.hello) })
    expect(hello.status).toBe(200)
    const answer = (await hello.json()) as { session: string; accept: { e: string; proof: string } }
    const done = await started.finish(answer.accept)
    if (done === null) throw new Error('no proof')
    const finish = await fetch(`${this.origin}/~seal/finish`, { method: 'POST', headers: this.headers, body: JSON.stringify({ session: answer.session, ...done.finish }) })
    expect(finish.status).toBe(200)
    this.session = done.session
    this.inbox = createInbox(done.session, (plain) => {
      const frame = decodeFrame(plain)
      if (frame) this.frames.push(frame)
    })
    await this.listen()
  }

  async listen(from = this.inbox?.next() ?? 0): Promise<void> {
    this.stream?.abort()
    const abort = new AbortController()
    this.stream = abort
    const down = await fetch(`${this.origin}/~seal/down?s=${this.session?.id}&from=${from}`, { signal: abort.signal, headers: this.headers })
    expect(down.status).toBe(200)
    const reader = createRecordReader()
    void (async () => {
      try {
        for await (const chunk of down.body as unknown as AsyncIterable<Uint8Array>) {
          for (const record of reader.push(chunk)) await this.inbox?.accept(record)
        }
      } catch {
        // A hang-up, ours or theirs.
      }
    })()
  }

  hangUp(): void {
    this.stream?.abort()
  }

  async sealed(frame: SealFrame): Promise<SealRecord> {
    return (this.session as SealSession).seal(encodeFrame(frame))
  }

  post(...records: SealRecord[]): Promise<Response> {
    return fetch(`${this.origin}/~seal/up?s=${this.session?.id}`, { method: 'POST', headers: this.headers, body: Buffer.concat(records.map(encodeRecord)) })
  }

  async send(...frames: SealFrame[]): Promise<Response> {
    const records: SealRecord[] = []
    for (const frame of frames) records.push(await this.sealed(frame))
    return this.post(...records)
  }

  of(stream: number): SealFrame[] {
    return this.frames.filter((frame) => frame.stream === stream)
  }

  text(stream: number): string {
    return Buffer.concat(this.of(stream).flatMap((frame) => (frame.kind === 'data' ? [Buffer.from(frame.data)] : []))).toString()
  }
}

export const until = async (what: () => boolean, why: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
