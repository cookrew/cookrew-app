import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'
import { advancedStage, isFirstRunStage, isFirstTask, openingStage, pastTask, type FirstRunStage, type FirstTask } from '../shared/first-run'

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
  /** Anything but a new install with nothing on it. */
  hasContent: () => boolean
  hasAccount: () => boolean
}

interface Saved {
  stage: FirstRunStage | null
  task: FirstTask | null
  dirs: readonly string[]
}

function readSaved(file: string): Saved {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { stage?: unknown; task?: unknown; dirs?: unknown }
    return {
      stage: isFirstRunStage(saved.stage) ? saved.stage : null,
      task: isFirstTask(saved.task) ? saved.task : null,
      dirs: Array.isArray(saved.dirs) ? saved.dirs.filter((dir): dir is string => typeof dir === 'string') : []
    }
  } catch {
    return { stage: null, task: null, dirs: [] }
  }
}

export class FirstRunStore {
  private stage: FirstRunStage | null = null
  private held: FirstTask | null
  private known: readonly string[]

  constructor(
    private readonly file: string,
    private readonly facts: FirstRunFacts
  ) {
    const saved = readSaved(file)
    this.held = saved.task
    this.known = saved.dirs
  }

  /** The stage, deciding it on the first read: at boot, before the Conductor is seeded. */
  read(): FirstRunStage {
    if (this.stage !== null) return this.stage
    return this.keep(readSaved(this.file).stage ?? this.opening())
  }

  advance(to: FirstRunStage): FirstRunStage {
    const stage = this.keep(advancedStage(this.read(), to))
    if (this.held?.state === 'sent' && pastTask(stage)) this.setTask(null)
    return stage
  }

  /** The first task's words, kept here so a restart cannot lose them. */
  task(): FirstTask | null {
    return this.held
  }

  setTask(task: FirstTask | null): void {
    this.held = task
    this.save()
  }

  /** What the tool check learned about the login shell: panes need it before any check runs. */
  dirs(): readonly string[] {
    return this.known
  }

  rememberDirs(dirs: readonly string[]): void {
    const next = [...new Set([...this.known, ...dirs])]
    if (next.length === this.known.length) return
    this.known = next
    this.read()
    this.save()
  }

  private opening(): FirstRunStage {
    try {
      return openingStage({ saved: null, hasContent: this.facts.hasContent(), hasAccount: this.facts.hasAccount() })
    } catch (error) {
      console.error('First run: the facts could not be read, closing it:', error)
      return 'closed'
    }
  }

  private keep(stage: FirstRunStage): FirstRunStage {
    const moved = stage !== this.stage
    this.stage = stage
    if (moved) this.save()
    return stage
  }

  private save(): void {
    try {
      const { stage, held: task, known: dirs } = this
      writeFileAtomic(this.file, `${JSON.stringify({ stage, ...(task ? { task } : {}), ...(dirs.length > 0 ? { dirs } : {}) })}\n`)
    } catch (error) {
      console.error('First run: the stage could not be saved:', error)
    }
  }
}
