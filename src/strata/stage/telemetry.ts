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
