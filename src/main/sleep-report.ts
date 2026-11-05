// A SWEEP THAT SAYS NOTHING CAN BE DEAD FOR WEEKS.
//
// 2026-11-05: idle sleep ended about one agent a day while 37 sat idle for up to
// two days, and nothing anywhere said so; the only trace of a broken gate was a
// machine paging itself to a stop. Every sweep now leaves one line per running
// card saying why it is still awake, so that question is a file read:
//
//   cat ~/.cookrew/sleep-sweep.json
//
// SCOPE — pure wording plus one best-effort write. It decides nothing.

import { renameSync, writeFileSync } from 'node:fs'
import type { SleepFacts } from './agent-sleep'
import type { PressureLevel } from './machine-pressure'

export interface SleepReportCard {
  id: string
  name: string
  why: string
}

export interface SleepReport {
  at: number
  pressure: PressureLevel
  windowMin: number
  awake: number
  cards: readonly SleepReportCard[]
}

/** The gate holding this card, from the nearest fact out. */
export function reasonAwake(
  facts: SleepFacts,
  busyWhy: string | null,
  evidenceWhy: string | null,
  nominated: boolean
): string {
  if (!facts.resumable) return 'cannot be resumed exactly'
  if (facts.served) return 'served session'
  if (facts.busy) return `busy: ${busyWhy ?? 'focused'}`
  if (evidenceWhy !== null) return evidenceWhy
  return nominated ? 'nominated' : 'window not over'
}

export function sleepReport(input: {
  at: number
  pressure: PressureLevel
  windowMs: number
  cards: readonly SleepReportCard[]
}): SleepReport {
  return {
    at: input.at,
    pressure: input.pressure,
    windowMin: Math.round(input.windowMs / 60_000),
    awake: input.cards.length,
    cards: input.cards
  }
}

/** Atomic, and best-effort: the sweep it describes matters more than the report. */
export function writeSleepReport(file: string, report: SleepReport): void {
  try {
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(report, null, 1)}\n`)
    renameSync(temp, file)
  } catch {
    // An unwritable report is no reason to stop sleeping agents.
  }
}
