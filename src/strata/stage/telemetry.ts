// What each flight was, for the perf evidence and the prototype's readout.
// User-timing marks land in Chrome traces as blink.user_timing, so a trace can
// be cut into flights without guessing.

export interface FlightRecord {
  id: number
  kind: string
  geometry: 'zoom' | 'hop' | 'fade'
  mode: 'auto' | 'scrub'
  steps: number
  /** Growth per step. */
  K: number[]
  planned: number
  easing: string
  takeoff: number
  landed: number | null
  outcome: 'to' | 'from' | 'replaced' | null
}

type Listener = (record: FlightRecord) => void

const KEEP = 64
let records: FlightRecord[] = []
let listeners: Listener[] = []

const mark = (name: string) => {
  try {
    performance.mark(name)
  } catch {
    // marks are evidence, never a reason to fail a flight
  }
}

export const recordTakeoff = (record: Omit<FlightRecord, 'takeoff' | 'landed' | 'outcome'>): void => {
  mark(`glide:takeoff:${record.id}`)
  records = [...records.slice(1 - KEEP), { ...record, takeoff: performance.now(), landed: null, outcome: null }]
}

/** A scrub's finger lifted: before it the camera follows input, after it the compositor settles. */
export const recordRelease = (id: number): void => mark(`glide:release:${id}`)

export const recordLanding = (id: number, outcome: NonNullable<FlightRecord['outcome']>): void => {
  const found = records.find((r) => r.id === id)
  if (!found || found.outcome) return
  mark(`glide:land:${id}`)
  try {
    performance.measure(`glide:flight:${found.kind}`, `glide:takeoff:${id}`, `glide:land:${id}`)
  } catch {
    // a missing start mark (cleared by a profiler) only loses the measure
  }
  const done = { ...found, landed: performance.now(), outcome }
  records = records.map((r) => (r.id === id ? done : r))
  listeners.forEach((fn) => fn(done))
}

// ── where the stage rests, outside React ──
// Whatever waits for the camera to stop (Harbor's frame layer shows the real
// terminal only once the stage rests at it) listens here; null while flying.

type RestListener = (rest: string | null) => void
let resting: string | null = null
let restListeners: RestListener[] = []

/** Called by the stage: the pathKey it rests at, or null at take-off. */
export const recordRest = (key: string | null): void => {
  if (resting === key) return
  resting = key
  restListeners.forEach((fn) => fn(key))
}

export const stageRest = {
  /** The pathKey (plan.ts) the stage rests at, or null while a flight is under way. */
  get: (): string | null => resting,
  subscribe(fn: RestListener): () => void {
    restListeners = [...restListeners, fn]
    return () => {
      restListeners = restListeners.filter((l) => l !== fn)
    }
  }
}

export const flightLog = {
  all: (): FlightRecord[] => records,
  last: (): FlightRecord | undefined => records[records.length - 1],
  /** Called at every landing; returns an unsubscribe. */
  subscribe(fn: Listener): () => void {
    listeners = [...listeners, fn]
    return () => {
      listeners = listeners.filter((l) => l !== fn)
    }
  }
}
