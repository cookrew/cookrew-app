import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  sweepStorageInWorker,
  type StorageGcWorker
} from '../src/main/storage-gc-worker'
import type { SweepResult } from '../src/main/storage-gc-scan'

class FakeWorker extends EventEmitter implements StorageGcWorker {
  postMessage = vi.fn()
  unref = vi.fn()
}

const RESULT: SweepResult = {
  remove: [],
  bytes: 0,
  kept: { live: 2, withinGrace: 3 },
  applied: true,
  failed: []
}

describe('sweepStorageInWorker', () => {
  it('hands the scan to a worker and resolves its result', async () => {
    const worker = new FakeWorker()
    const pending = sweepStorageInWorker('/out/storage-gc-worker.js', { apply: true }, () => worker)

    expect(worker.postMessage).toHaveBeenCalledWith({ apply: true })
    expect(worker.unref).toHaveBeenCalledOnce()
    worker.emit('message', { ok: true, value: RESULT })
    await expect(pending).resolves.toEqual(RESULT)
  })

  it('rejects a worker failure instead of falling back to a main-thread scan', async () => {
    const worker = new FakeWorker()
    const pending = sweepStorageInWorker('/out/storage-gc-worker.js', { apply: true }, () => worker)

    worker.emit('error', new Error('worker unavailable'))
    await expect(pending).rejects.toThrow('worker unavailable')
    expect(worker.postMessage).toHaveBeenCalledOnce()
  })

  it('rejects a clean exit that never produced a result', async () => {
    const worker = new FakeWorker()
    const pending = sweepStorageInWorker('/out/storage-gc-worker.js', { apply: true }, () => worker)

    worker.emit('exit', 0)
    await expect(pending).rejects.toThrow('exited 0 before replying')
  })
})
