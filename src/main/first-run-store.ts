import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'
import { advancedStage, isFirstRunStage, openingStage, type FirstRunStage } from '../shared/first-run'

/**
 * THE FIRST RUN'S ONE DURABLE FACT: how far it has got, in userData.
 *
 * Main keeps it, not the renderer, because "this closes for good" has to hold
 * through a cleared web storage and a second window. The first read decides
 * who is new and writes the answer down at once, so the Setup card and the
 * first agent the run itself makes are never mistaken for an old hand's work.
 *
 * NOTHING HERE THROWS. A disk that refuses keeps the stage in memory for this
 * run. Facts that cannot be read close the run: an existing person seeing a
 * welcome is worse than a new one missing it.
 */

export interface FirstRunFacts {
  hasContent: () => boolean
  hasAccount: () => boolean
}

function readSaved(file: string): FirstRunStage | null {
  try {
    const stage = (JSON.parse(readFileSync(file, 'utf8')) as { stage?: unknown }).stage
    return isFirstRunStage(stage) ? stage : null
  } catch {
    return null
  }
}

export class FirstRunStore {
  private stage: FirstRunStage | null = null

  constructor(
    private readonly file: string,
    private readonly facts: FirstRunFacts
  ) {}

  /** The stage, deciding it on the first read. `oldCardClosed` is the renderer's memory of the retired launch card. */
  read(oldCardClosed: boolean): FirstRunStage {
    if (this.stage !== null) return this.stage
    const saved = readSaved(this.file)
    return this.keep(saved ?? this.opening(oldCardClosed))
  }

  advance(to: FirstRunStage): FirstRunStage {
    const from = this.stage ?? readSaved(this.file) ?? this.opening(false)
    return this.keep(advancedStage(from, to))
  }

  private opening(oldCardClosed: boolean): FirstRunStage {
    try {
      return openingStage({ saved: null, hasContent: this.facts.hasContent(), hasAccount: this.facts.hasAccount(), oldCardClosed })
    } catch (error) {
      console.error('First run: the facts could not be read, closing it:', error)
      return 'closed'
    }
  }

  private keep(stage: FirstRunStage): FirstRunStage {
    if (stage !== this.stage) this.save(stage)
    this.stage = stage
    return stage
  }

  private save(stage: FirstRunStage): void {
    try {
      writeFileAtomic(this.file, `${JSON.stringify({ stage })}\n`)
    } catch (error) {
      console.error('First run: the stage could not be saved:', error)
    }
  }
}
