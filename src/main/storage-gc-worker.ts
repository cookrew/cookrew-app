import { Worker } from 'node:worker_threads'
import type { SweepOptions, SweepResult } from './storage-gc-scan'

interface SweepWorkerReply {
  ok: boolean
  value?: SweepResult
  error?: string
}

/** Minimal worker surface so failure paths can be tested without a real scan. */
export interface StorageGcWorker {
  once(event: 'message', listener: (reply: SweepWorkerReply) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number) => void): this
  postMessage(value: SweepOptions): void
  unref(): void
}

export type StorageGcWorkerSpawn = (file: string) => StorageGcWorker

/**
 * Run the disk sweep away from Electron's main thread.
 *
 * The live store is large enough that scanning saved session sidecars can take
 * many seconds of CPU. A timer only postponed that freeze. The dedicated build
 * entry imports the real sweep implementation, so the deletion policy remains
 * single-sourced; this client only owns worker lifecycle and result delivery.
 */
export function sweepStorageInWorker(
  workerFile: string,
  options: SweepOptions = {},
  spawn: StorageGcWorkerSpawn = (file) => new Worker(file) as StorageGcWorker
): Promise<SweepResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      action()
    }

    let worker: StorageGcWorker
    try {
      worker = spawn(workerFile)
    } catch (error) {
      reject(error)
      return
    }

    worker.once('message', (reply) => {
      finish(() => {
        if (reply.ok && reply.value) resolve(reply.value)
        else reject(new Error(reply.error ?? 'storage sweep worker returned no result'))
      })
    })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`storage sweep worker exited ${code} before replying`)))
    })
    worker.postMessage(options)
    // Maintenance must not keep an otherwise-finished app open.
    worker.unref()
  })
}
