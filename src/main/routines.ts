import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RoutineSpec } from '../shared/model'
import type { PtyManager } from './pty'
import type { WorkspaceStore } from './store'

const ROUTINES_FILE = path.join(homedir(), '.cookrew', 'routines.json')
const TICK_MS = 15000

interface RoutineRuntime {
  spec: RoutineSpec
  nextFireAt: number
}

/**
 * Cron-lite scheduler: fires routine commands into terminal PTYs.
 * Cron-lite routines with `--every` and `--daily` schedules.
 */
export class RoutineScheduler {
  private routines: RoutineRuntime[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private store: WorkspaceStore,
    private ptys: PtyManager
  ) {
    this.routines = load().map((spec) => ({ spec, nextFireAt: nextFire(spec, Date.now()) }))
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  list(): RoutineSpec[] {
    return this.routines.map((r) => r.spec)
  }

  create(spec: Omit<RoutineSpec, 'id' | 'fireCount'>): RoutineSpec {
    const full: RoutineSpec = { ...spec, id: randomUUID(), fireCount: 0 }
    this.routines = [...this.routines, { spec: full, nextFireAt: nextFire(full, Date.now()) }]
    void this.persist()
    return full
  }

  remove(name: string): RoutineSpec {
    const found = this.byName(name)
    this.routines = this.routines.filter((r) => r.spec.id !== found.id)
    void this.persist()
    return found
  }

  setEnabled(name: string, enabled: boolean): RoutineSpec {
    const found = this.byName(name)
    this.routines = this.routines.map((r) =>
      r.spec.id === found.id
        ? { spec: { ...r.spec, enabled }, nextFireAt: nextFire(r.spec, Date.now()) }
        : r
    )
    void this.persist()
    return { ...found, enabled }
  }

  run(name: string): RoutineSpec {
    const found = this.byName(name)
    this.fire(found)
    return found
  }

  private byName(name: string): RoutineSpec {
    const found = this.routines.find(
      (r) => r.spec.name.toLowerCase() === name.toLowerCase()
    )
    if (!found) throw new Error(`Routine '${name}' not found. Run 'cookrew routine list'.`)
    return found.spec
  }

  private tick(): void {
    const now = Date.now()
    this.routines = this.routines.map((r) => {
      if (!r.spec.enabled || now < r.nextFireAt) return r
      this.fire(r.spec)
      const spec = { ...r.spec, fireCount: r.spec.fireCount + 1 }
      return { spec, nextFireAt: nextFire(spec, now) }
    })
  }

  private fire(spec: RoutineSpec): void {
    const targetId = spec.terminalId ?? this.store.terminals()[0]?.id
    if (!targetId) return
    const session = this.ptys.get(targetId)
    if (!session) return
    session.write(spec.command)
    session.write('\r')
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(ROUTINES_FILE), { recursive: true })
      await fs.writeFile(
        ROUTINES_FILE,
        JSON.stringify(this.routines.map((r) => r.spec), null, 2),
        'utf8'
      )
    } catch (error) {
      console.error('Failed to persist routines:', error)
    }
  }
}

function nextFire(spec: RoutineSpec, from: number): number {
  if (spec.schedule.type === 'every') return from + spec.schedule.ms
  const [hours, minutes] = spec.schedule.time.split(':').map((n) => parseInt(n, 10))
  const next = new Date(from)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** Parse `45s`, `30m`, `2h`, `1h30m`, or a bare number of minutes. */
export function parseInterval(input: string): number {
  if (/^\d+$/.test(input)) return parseInt(input, 10) * 60_000
  let total = 0
  const matches = input.matchAll(/(\d+)([smh])/g)
  for (const [, amount, unit] of matches) {
    const n = parseInt(amount, 10)
    total += unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
  }
  if (total === 0) throw new Error(`Cannot parse interval '${input}' (use 45s, 30m, 2h, 1h30m)`)
  return total
}

function load(): RoutineSpec[] {
  try {
    if (existsSync(ROUTINES_FILE)) {
      return JSON.parse(readFileSync(ROUTINES_FILE, 'utf8')) as RoutineSpec[]
    }
  } catch (error) {
    console.error('Failed to load routines:', error)
  }
  return []
}
