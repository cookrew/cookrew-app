// The fold's OVERSIZED-record codec: JSON.parse / JSON.stringify of records
// past the 1 MB bound, off Electron main (Sol r11 P1).
//
// Round 10 left one stated residual in the fold: byte-bounded chunks bound
// every ORDINARY stretch, but a single oversized TurnRecord still parsed and
// serialized synchronously — an 8 MB tool reply monopolized the main thread
// for exactly one unbounded unit, isolated between yields but not shortened
// by them. The only way off the thread is a worker, so here is the worker.
//
// WHAT CROSSES THE BOUNDARY, AND WHY THE WIN IS REAL
// --------------------------------------------------
// Only the byte-proportional JSON work moves: the main thread keeps the
// annotation split/merge (O(fields), not O(bytes)) and hands the worker a raw
// line (parse) or a plain conversation record (serialize). The answer comes
// back by structured clone — which for a string-bearing object is a memcpy,
// NOT a parse: receiving an 8 MB reply costs main a copy measured in
// milliseconds where JSON.parse cost it an unbounded synchronous stretch of
// allocation and traversal. That asymmetry is the entire point.
//
// WHY AN EVAL WORKER AND NOT A WORKER FILE PATH
// ---------------------------------------------
// The worker entry has to resolve under BOTH electron-vite's main-process
// bundle and vitest's on-the-fly TS — a file path satisfies neither without
// build configuration that would drift. The worker needs nothing from this
// codebase (the annotation split stayed on main precisely so the worker is
// pure JSON), so its source ships as a string and spawns with `eval: true`,
// which Node runs as plain CommonJS regardless of the package's module type
// (verified against this repo's node).
//
// FAILURE POLICY: the worker is an optimization, never a correctness
// dependency. A crash — spawn refusal, error, unexpected exit — settles every
// pending request as 'worker-down', says so out loud ONCE, and latches the
// codec broken: callers fall back to the synchronous parse/serialize the fold
// always had, correct at the old tail-latency cost. No respawn loop: a worker
// that died once is a worker that can die again mid-fold, and deterministic
// degradation beats flapping.

import { Worker } from 'node:worker_threads'

/**
 * The oversized bound (Sol r11 P1): a line or record past this many bytes
 * parses and serializes in the worker; everything smaller keeps the
 * in-thread byte-bounded path (FOLD_*_CHUNK_BYTES units in turn-store).
 */
export const OVERSIZED_RECORD_BYTES = 1024 * 1024

/**
 * One codec answer. 'invalid' means the INPUT was bad — the same verdict the
 * synchronous path would reach, so the caller drops the line without any
 * fallback. 'worker-down' means the infrastructure failed — the caller falls
 * back to the synchronous path, because the input deserves a real attempt.
 */
export type CodecAnswer<T> =
  | { ok: true; value: T }
  | { ok: 'invalid' }
  | { ok: 'worker-down' }

/** What the worker receives: one request, tagged for the reply map. */
interface CodecRequest {
  id: number
  kind: 'parse' | 'serialize'
  /** The raw line (parse) — absent on serialize. */
  text?: string
  /** The conversation record (serialize) — absent on parse. */
  value?: unknown
}

interface CodecReply {
  id: number
  ok: true | 'invalid'
  value?: unknown
}

/**
 * The worker body — pure JSON, no imports beyond worker_threads, evaluated
 * as CommonJS via `eval: true`. Kept deliberately free of anything from this
 * codebase so the eval string cannot drift from a module it would otherwise
 * have to duplicate.
 */
const FOLD_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (msg) => {
  try {
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      value: msg.kind === 'parse' ? JSON.parse(msg.text) : JSON.stringify(msg.value)
    })
  } catch {
    parentPort.postMessage({ id: msg.id, ok: 'invalid' })
  }
})
`

/**
 * Lazily-spawned single shared worker plus a promise map. One instance
 * serves every fold of a TurnStore: oversized records are rare, so the
 * worker does not exist until the first one appears, and it is unref'd so a
 * pending fold can never hold the app open.
 */
export class FoldRecordCodec {
  private worker: Worker | null = null
  /** Latched TRUE by any crash — every later request answers worker-down. */
  private broken = false
  private nextId = 1
  private readonly pending = new Map<number, (answer: CodecAnswer<unknown>) => void>()

  /** `spawn` is injectable so tests can drive spawn refusal and crashes. */
  constructor(private readonly spawn: () => Worker = () => new Worker(FOLD_WORKER_SOURCE, { eval: true })) {}

  /** JSON.parse one oversized line off-thread. */
  parseOversized(text: string): Promise<CodecAnswer<unknown>> {
    return this.request({ kind: 'parse', text })
  }

  /** JSON.stringify one oversized conversation record off-thread. */
  serializeOversized(value: unknown): Promise<CodecAnswer<string>> {
    return this.request({ kind: 'serialize', value }) as Promise<CodecAnswer<string>>
  }

  /**
   * Tear the worker down without the crash note (tests, process end).
   * Pending requests settle worker-down — their callers fall back
   * synchronously — and the codec stays latched.
   */
  dispose(): void {
    const worker = this.worker
    this.worker = null
    this.broken = true
    this.settleAllPending()
    void worker?.terminate()
  }

  private request(body: Omit<CodecRequest, 'id'>): Promise<CodecAnswer<unknown>> {
    if (this.broken) return Promise.resolve({ ok: 'worker-down' })
    const worker = this.ensureWorker()
    if (worker === null) return Promise.resolve({ ok: 'worker-down' })
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      worker.postMessage({ id, ...body })
    })
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== null) return this.worker
    try {
      const worker = this.spawn()
      worker.on('message', (reply: CodecReply) => {
        const resolve = this.pending.get(reply.id)
        if (resolve === undefined) return
        this.pending.delete(reply.id)
        resolve(reply.ok === true ? { ok: true, value: reply.value } : { ok: 'invalid' })
      })
      worker.on('error', (error) => this.crash(error))
      // ANY exit while the codec is live is a crash: the worker serves the
      // whole process lifetime, so even a clean exit 0 means requests in
      // flight (or to come) have nobody to answer them.
      worker.on('exit', (code) => this.crash(new Error(`fold worker exited (code ${code})`)))
      worker.unref()
      this.worker = worker
      return worker
    } catch (error) {
      this.crash(error)
      return null
    }
  }

  /** Loud once, broken forever: the fallback is synchronous and correct. */
  private crash(error: unknown): void {
    if (!this.broken) {
      console.error(
        'Turn-ledger fold worker died — oversized records fall back to SYNCHRONOUS ' +
          'parse/serialize on the main thread (correct, but the tail-latency bound is lost):',
        error
      )
    }
    this.broken = true
    this.worker = null
    this.settleAllPending()
  }

  private settleAllPending(): void {
    // Snapshot before clearing: a resolver could (in principle) re-enter
    // request(), and mutating the map mid-iteration must not skip anyone.
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const resolve of waiting) resolve({ ok: 'worker-down' })
  }
}
