import { waitOfScreen, type FirstTask } from '../shared/first-run'
import type { FirstRunStore } from './first-run-store'

/**
 * A PERSON'S FIRST TASK, HELD UNTIL AN AGENT HAS IT (round 2, bugs 3 and 4).
 *
 * The first screen used to move on the moment a card existed, so an agent that
 * died took the words with it and the run went on as if it had worked. Now the
 * stage moves when the agent took the words and at no other time. Until then
 * they are in first-run.json, so neither a dead agent nor a restart loses them:
 * a dead agent hands them back to the box with a reason, and its card goes, as
 * the first screen is about to make another.
 */

export interface HoldHooks {
  /** The agent's process has ended. */
  gone: () => boolean
  /** Up and quiet, and not taking input: this is on its screen. */
  onWait: (screen: string) => void
}

interface HeldSession {
  once: (event: 'exit', listener: () => void) => unknown
}

export interface FirstTasksDeps<S extends HeldSession = HeldSession> {
  store: Pick<FirstRunStore, 'task' | 'setTask' | 'advance'>
  /** Resolves when the words went in; rejects when they never can. */
  inject: (session: S, words: string, hooks: HoldHooks) => Promise<void>
  /** The agent's live session, re-attaching one a restart left behind; null when there is none. */
  session: (id: string) => S | null
  removeCard: (id: string) => void
  emit: () => void
}

/** Why it stopped, in words a new person can use. */
export function whyStopped(harness: string, screen: string): string {
  return /not found|no such file|command not found/i.test(screen)
    ? `${harness} could not start on this computer. Check that it is installed, then send your task again.`
    : `${harness} stopped before it took your task. Your words are back in the box.`
}

export class FirstTasks<S extends HeldSession = HeldSession> {
  /** The hold under way: a late settle of an older one changes nothing. */
  private ticket = 0
  private resumed = false

  constructor(private readonly deps: FirstTasksDeps<S>) {}

  hold(id: string, words: string, harness: string): void {
    const ticket = ++this.ticket
    const session = this.deps.session(id)
    if (session === null) return this.handBack(words, whyStopped(harness, ''), id)
    let gone = false
    let screen = ''
    session.once('exit', () => {
      gone = true
    })
    this.show({ state: 'holding', id, words, harness, wait: 'starting' })
    const onWait = (now: string): void => {
      screen = now
      const task = this.deps.store.task()
      const wait = waitOfScreen(now)
      if (ticket === this.ticket && task?.state === 'holding' && task.wait !== wait) this.show({ ...task, wait })
    }
    this.deps.inject(session, words, { gone: () => gone, onWait }).then(
      () => {
        if (ticket !== this.ticket) return
        this.deps.store.setTask(null)
        this.deps.store.advance('phone')
        this.deps.emit()
      },
      () => {
        if (ticket !== this.ticket) return
        this.handBack(words, whyStopped(harness, screen), id)
        this.deps.removeCard(id)
      }
    )
  }

  /** The person called it off from the waiting screen. */
  discard(): void {
    const task = this.deps.store.task()
    if (task?.state !== 'holding') return
    this.ticket += 1
    this.handBack(task.words, null, task.id)
    this.deps.removeCard(task.id)
  }

  /** The app is quitting: whatever settles now changes nothing, and the record waits for the next launch. */
  stop(): void {
    this.ticket += 1
  }

  /** After a restart: hold on for the same agent, or hand the words back. Once per run. */
  resume(): void {
    if (this.resumed) return
    this.resumed = true
    const task = this.deps.store.task()
    if (task?.state === 'holding') this.hold(task.id, task.words, task.harness)
  }

  private handBack(words: string, why: string | null, id: string): void {
    this.show({ state: 'returned', words, why, id })
  }

  private show(task: FirstTask): void {
    this.deps.store.setTask(task)
    this.deps.emit()
  }
}
