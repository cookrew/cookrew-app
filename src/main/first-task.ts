import { waitOfScreen, type FirstTask } from '../shared/first-run'
import type { LaunchFailure } from '../shared/launch-failure'
import type { FirstRunStore } from './first-run-store'

/**
 * A PERSON'S FIRST TASK, HELD UNTIL AN AGENT HAS IT (round 2, bugs 3 and 4).
 *
 * The first screen used to move on the moment a card existed, so an agent that
 * died took the words with it and the run went on as if it had worked. Now the
 * words are in first-run.json until a good turn has ended, so neither a dead agent
 * nor a restart loses them: a dead agent hands them back to the box with a reason,
 * and its card goes, as the first screen is about to make another. The reason is
 * the card's own (shared/launch-failure.ts): one wording of why an agent is not
 * running, read before the card goes.
 *
 * DELIVERY MOVES NOTHING. A provider can refuse the turn after the words go in
 * (Part C: a 400 read as done), so a delivered task is `sent`, the screens step
 * aside, and only a turn that ended well moves the stage (FirstRunHints.tsx). A
 * refused turn's agent is left alone: it may hold real work, and the person can
 * reply to it or start over.
 */

export interface HoldHooks {
  /** The agent's process has ended. */
  gone: () => boolean
  /** Up and quiet, and not taking input: this is on its screen. */
  onWait: (screen: string) => void
}

interface HeldSession {
  once: (event: 'exit', listener: () => void) => unknown
  /** Cookrew let go of its mirror: the agent's process is not what ended. */
  wasDisposed?: boolean
}

export interface FirstTasksDeps<S extends HeldSession = HeldSession> {
  store: Pick<FirstRunStore, 'task' | 'setTask' | 'advance'>
  /** Resolves when the words went in; rejects when they never can. */
  inject: (session: S, words: string, hooks: HoldHooks) => Promise<void>
  /** The agent's live session, re-attaching one a restart left behind; null when there is none. */
  session: (id: string) => S | null
  removeCard: (id: string) => void
  emit: () => void
  /**
   * Hold a viewer on the agent; the return lets go. An idle agent with no viewer
   * has its local mirror dropped after 45 s (lazy-terminal.ts), which disposes
   * the session mid-wait: a task open on it must keep it up.
   */
  keep: (id: string) => () => void
  /** A close of this card is under way: its exit is that, and `cardGone` says how it ended. */
  closing: (id: string) => boolean
  /** What the card has on file about why it is not running. */
  failure: (id: string) => Pick<LaunchFailure, 'why' | 'fix' | 'lastLines'> | null
}

/** For the agent that left no failure on file. */
const whyStopped = (harness: string): string => `${harness} stopped before it took your task. Your words are back in the box.`
const whyEnded = (harness: string): string => `${harness} stopped before it finished your task. Your words are back in the box.`

type Told = Pick<Extract<FirstTask, { state: 'returned' }>, 'why' | 'fix' | 'lines'>

export class FirstTasks<S extends HeldSession = HeldSession> {
  /** The hold under way: a late settle of an older one changes nothing. */
  private ticket = 0
  private resumed = false
  private letGo: (() => void) | null = null

  constructor(private readonly deps: FirstTasksDeps<S>) {}

  hold(id: string, words: string, harness: string): void {
    const ticket = ++this.ticket
    const session = this.deps.session(id)
    if (session === null) return this.died(id, words, whyStopped(harness))
    this.keepUp(id)
    let gone = false
    session.once('exit', () => {
      gone = true
      if (!session.wasDisposed && !this.deps.closing(id)) this.endedAfterSent(ticket, id)
    })
    this.show({ state: 'holding', id, words, harness, wait: 'starting' })
    const onWait = (now: string): void => {
      const task = this.deps.store.task()
      const wait = waitOfScreen(now)
      if (ticket === this.ticket && task?.state === 'holding' && task.wait !== wait) this.show({ ...task, wait })
    }
    this.deps.inject(session, words, { gone: () => gone, onWait }).then(
      () => {
        if (ticket === this.ticket) this.show({ state: 'sent', id, words, harness })
      },
      () => {
        if (ticket !== this.ticket || this.deps.closing(id)) return
        // Its session was replaced (a restart in place), not ended: the card is live.
        if (session.wasDisposed) return this.handBack(words, { why: null }, id)
        this.died(id, words, whyStopped(harness))
      }
    )
  }

  /** The agent went after it had the words: only a turn's good end ends the watch. */
  private endedAfterSent(ticket: number, id: string): void {
    const task = this.deps.store.task()
    if (ticket !== this.ticket || task?.state !== 'sent' || task.id !== id) return
    this.died(id, task.words, whyEnded(task.harness))
  }

  /**
   * The person called it off: from the waiting screen, where the agent is doing
   * nothing yet and goes; or from a refused turn, where it stays, work and all.
   */
  discard(): void {
    const task = this.deps.store.task()
    if (task?.state !== 'holding' && task?.state !== 'sent') return
    this.ticket += 1
    this.handBack(task.words, { why: null }, task.id)
    if (task.state === 'holding') this.deps.removeCard(task.id)
  }

  /**
   * Its card has gone, by hand or otherwise. Said by the removal itself, once it
   * has happened: a close can fail with the process alive, and the exit cannot
   * tell a close from a death. A card this class removed has handed back already.
   */
  cardGone(id: string): void {
    const task = this.deps.store.task()
    if ((task?.state !== 'holding' && task?.state !== 'sent') || task.id !== id) return
    this.ticket += 1
    this.handBack(task.words, { why: null }, id)
  }

  /** A good turn ended it from outside (the stage moved): nothing is open any more. */
  sync(): void {
    const task = this.deps.store.task()
    if (task?.state !== 'holding' && task?.state !== 'sent') this.release()
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
    if (task?.state !== 'sent') return
    const ticket = ++this.ticket
    const session = this.deps.session(task.id)
    if (session === null) return this.handBack(task.words, this.told(task.id, whyEnded(task.harness)), task.id)
    this.keepUp(task.id)
    session.once('exit', () => {
      if (!session.wasDisposed && !this.deps.closing(task.id)) this.endedAfterSent(ticket, task.id)
    })
  }

  private keepUp(id: string): void {
    this.release()
    this.letGo = this.deps.keep(id)
  }

  private release(): void {
    this.letGo?.()
    this.letGo = null
  }

  /** What the card says of itself, or the sentence for one that says nothing. */
  private told(id: string, fallback: string): Told {
    const failure = this.deps.failure(id)
    return failure ? { why: failure.why, fix: failure.fix, lines: failure.lastLines } : { why: fallback }
  }

  /** It is not coming back: the words go home with its reason, then its card goes. */
  private died(id: string, words: string, fallback: string): void {
    this.handBack(words, this.told(id, fallback), id)
    this.deps.removeCard(id)
  }

  private handBack(words: string, told: Told, id: string): void {
    this.release()
    this.show({ state: 'returned', words, ...told, id })
  }

  private show(task: FirstTask): void {
    this.deps.store.setTask(task)
    this.deps.emit()
  }
}
