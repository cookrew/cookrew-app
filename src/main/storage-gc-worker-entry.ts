import { parentPort } from 'node:worker_threads'
import { sweepStorage, type SweepOptions } from './storage-gc-scan'

const port = parentPort
if (!port) throw new Error('storage GC worker started without a parent port')

port.once('message', (options: SweepOptions) => {
  try {
    port.postMessage({ ok: true, value: sweepStorage(options) })
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    port.close()
  }
})
