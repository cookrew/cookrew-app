import { cliCopy, type CliCopyId } from '../shared/account-copy'
import {
  ladderIsOver,
  normaliseUsername,
  registryMismatchSentence,
  type AccountDevice,
  type AccountRefusal,
  type AccountResult,
  type ApprovalAsked,
  type LadderFactor,
  type ProviderSignInAnswer,
  type SecondFactorStep,
  type SignInAnswer
} from '../shared/account-v2'
import { machineCopy, registryWord } from '../shared/machine-words'
import type { CliRequest, TerminalNodeData } from '../shared/model'
import { LADDER_TTL_MS, type TypedFactor } from './account-ladder'
import type { DeviceCode } from './account-oauth'
import { registryOrigin } from './registry-origin'

/**
 * `cookrew login`, `logout` AND `whoami`: THE ACCOUNT, FROM A TERMINAL.
 *
 * WHY. A machine with no visible window (the Solis Linux box runs Electron on
 * Xvfb) has no avatar to click, and the avatar was the only door. Signing in
 * is what adds a device; there is no separate step. So this writes no second
 * path: every act goes to the functions the sheet's channels call
 * (account-ipc.ts · accountDoor), which end in the same `signedIn()` that files
 * the desktop.
 *
 * THE WHOLE CONVERSATION LIVES HERE AND THE CLI IS A PRINTER AND A KEYBOARD. It
 * prints `say`, reads what `ask` describes, and sends back the answer. That
 * keeps every decision testable with no terminal, and it keeps the CLI script,
 * which is copied alone next to the socket, free of account rules.
 *
 * WHAT IS TYPED IS NOT A REQUEST FIELD. Every answer rides beside the request
 * in `secret`, which socket-server.ts · handleLine takes off the JSON first,
 * so it is never in `args` or `flags` and nothing that reads a request can log
 * it. In the pane the keys are sealed from the turn tracker (PtySession ·
 * sealInput) from before the first prompt to the end. The pending id stays
 * here too, and the password stays where it always did, in main, keyed by that
 * id (account-ladder.ts).
 *
 * AN AGENT MUST NOT DO THIS SILENTLY, and here is what that comes to:
 *
 *   The caller is held to `ownerPaneOf`, the rule `cookrew secret` keeps.
 *   That alone is not enough: an agent's own pane IS an owner pane.
 *
 *   So a person has to be there. The CLI reports whether it has a terminal
 *   (an agent's tool call has none); a claude session in the caller's process
 *   tree is refused; and a pane whose agent is mid-turn is refused, which is
 *   what stops a faked tty (`script`), since an agent's tools only run in its
 *   turn.
 *
 *   None of that sees an agent typing into a Shell card with `cookrew ask
 *   --raw`: the caller there has a real tty and looks like a person. The keys
 *   do not (pane-input.ts). A pane last written by anything but a keyboard is
 *   refused, and while a prompt is open nothing but a keyboard can answer it.
 *
 *   Those are the app's own checks, so none is a wall. Any process of this user
 *   can go round them: straight to the socket or the multiplexer, or to the
 *   phone's raw key route with the token in ~/.cookrew/pairing-token, which
 *   counts as a keyboard because for the phone it is one. Every attempt the app
 *   sees, refused or not, goes in the event log; and what actually keeps the
 *   account shut is unchanged: the password, then the second factor.
 */

export const LOGIN_EXIT = { ok: 0, failed: 1, refused: 3 } as const

/** A sentence for the terminal, naming the registry this app really talks to. */
const said = (id: CliCopyId, platform: string, vars: Readonly<Record<string, string | number>> = {}): string =>
  cliCopy(id, platform, vars, registryWord(registryOrigin()))

/** Three wrong passwords and the conversation ends. The registry counts its own. */
const PASSWORD_TRIES = 3

/** A person who walked away from a prompt. The ladder itself lasts no longer. */
const IDLE_MS = LADDER_TTL_MS

/** How long a client gets to go after being hung up on. */
const HANG_UP_MS = 5_000

export class LoginRefused extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = 'LoginRefused'
    this.exitCode = exitCode
  }
}

/** What the CLI does next. Exactly one of `ask`, `wait` and `exit`, or none after a stop. */
export interface LoginTurn {
  say: readonly string[]
  ask?: {
    kind: 'text' | 'hidden' | 'choice'
    prompt: string
    options?: readonly { key: string; label: string }[]
  }
  /** Call `wait` next. `other` is true when pressing c can reach another rung. */
  wait?: { other: boolean }
  exit?: number
}

export interface AccountWho {
  username: string | null
  /** No password exists, so nothing here may ask for one. */
  passwordless: boolean
  /** No password was typed here and no passcode is chosen, so no lock can engage. */
  passcodePending: boolean
  deviceId: string
  deviceName: string
  sessionLive: boolean
  registry: string | null
  mismatch: { signedInAt: string; pointedAt: string } | null
}

/** The sheet's own account functions (account-ipc.ts · accountDoor). */
export interface AccountDoor {
  platform: string
  who: () => AccountWho
  signIn: (input: { username: string; password: string }) => Promise<SignInAnswer<unknown>>
  resume: (password: string) => Promise<SignInAnswer<unknown>>
  climbCode: (pending: string, factor: TypedFactor, code: string) => Promise<SignInAnswer<unknown>>
  askApproval: (pending: string) => Promise<AccountResult<ApprovalAsked>>
  waitApproval: (pending: string, signal: AbortSignal) => Promise<SignInAnswer<unknown>>
  abandon: (pending: string) => void
  signOut: (password: string) => Promise<AccountResult<unknown>>
  devices: () => Promise<AccountResult<readonly AccountDevice[]>>
  /** GitHub's device flow. `onCode` fires once, with what the person must type. */
  providerDevice: (onCode: (code: DeviceCode) => void, signal: AbortSignal) => Promise<ProviderSignInAnswer<unknown>>
  /** The name, for the identity the device flow just proved. */
  providerClaim: (username: string) => Promise<SignInAnswer<unknown>>
  abandonClaim: () => void
}

/** One line in the event log. A reason and a name; never anything typed. */
export interface LoginAudit {
  type: 'account.login' | 'account.logout' | 'account.login-refused'
  terminalId: string
  details: string
}

export interface LoginDoorDeps {
  /** Null until main has wired the account, or in a test server that has none. */
  account: () => AccountDoor | null
  /** The caller, held to an owner pane (socket-server · ownerPaneOf). Throws. */
  ownerPane: (request: CliRequest) => TerminalNodeData
  /** Is the agent in this pane mid-turn? */
  agentBusy: (terminalId: string) => boolean
  /** Was the last thing to write in this pane something other than a keyboard? */
  driven: (terminalId: string) => boolean
  /** Hold this pane's keys back from the tracker. Answers the release. */
  seal: (terminalId: string) => () => void
  audit: (event: LoginAudit) => void
  sleep?: (ms: number) => Promise<void>
  /** How long a conversation may sit with nothing happening. */
  idleMs?: number
  hangUpMs?: number
}

/** The piece of a socket this needs. */
export interface LoginConnection {
  once: (event: 'close', listener: () => void) => unknown
  end: () => unknown
}

type Rung = Exclude<LadderFactor, 'passkey'>

/** The order the terminal offers them: the one that needs no typing first. */
const RUNG_ORDER: readonly Rung[] = ['approve', 'totp', 'recovery']

type Stage =
  | { at: 'username' }
  | { at: 'password'; username: string; tries: number; renew: boolean }
  | { at: 'logout'; username: string; tries: number }
  | { at: 'rung'; step: SecondFactorStep; rungs: readonly Rung[] }
  | { at: 'code'; step: SecondFactorStep; rungs: readonly Rung[]; factor: TypedFactor }
  | { at: 'waiting'; step: SecondFactorStep; rungs: readonly Rung[] }
  | { at: 'device' }
  | { at: 'handle'; suggest: string }
  | { at: 'over' }

const WAIT_RETRY_MS = 2_000

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isWrongPassword = (reason: AccountRefusal): boolean =>
  reason === 'session-expired' || reason === 'bad_credentials'

const SAID_REASONS: Partial<Record<AccountRefusal, CliCopyId>> = {
  rate_limited: 'refused.rate_limited',
  offline: 'refused.offline',
  'session-expired': 'refused.wrong-password',
  bad_credentials: 'refused.wrong-password',
  bad_code: 'refused.bad_code',
  bad_recovery: 'refused.bad_recovery',
  expired: 'refused.expired',
  not_offered: 'refused.expired',
  too_many_attempts: 'refused.too_many_attempts',
  denied: 'refused.denied',
  bad_username: 'refused.bad_username',
  password_change_required: 'refused.password_change_required',
  cancelled: 'refused.cancelled',
  wrong_identity: 'refused.wrong_identity',
  locked: 'refused.locked'
}

/** One sign-in or sign-out, from the first prompt to its end. */
class Conversation {
  private stage: Stage = { at: 'over' }
  private release: () => void = () => undefined
  /** The ladder this conversation opened and has not landed. */
  private pending: string | null = null
  private stopWaiting: AbortController | null = null
  private saidOffline = false
  /** The terminal has gone. An act still on the wire finishes the conversation. */
  private gone = false
  /** Acts on the wire right now. */
  private flights = 0
  /** The device flow's ending, for the `wait` after the one that showed the code. */
  private deviceTurn: Promise<LoginTurn> | null = null
  /** A proven identity is waiting for a name. */
  private naming = false
  /**
   * Over, with an ending the CLI has not collected. The poll can finish before
   * the second `wait` arrives, and a door already handed back would answer it
   * "no sign-in open" on a machine that has just signed in.
   */
  private uncollected = false
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly account: AccountDoor
  private readonly deps: LoginDoorDeps
  private readonly pane: TerminalNodeData
  private readonly leaving: boolean
  private readonly github: boolean
  private readonly ended: () => void
  private readonly hangUp: () => unknown

  constructor(input: {
    account: AccountDoor
    deps: LoginDoorDeps
    pane: TerminalNodeData
    leaving: boolean
    github: boolean
    ended: () => void
    hangUp: () => unknown
  }) {
    this.account = input.account
    this.deps = input.deps
    this.pane = input.pane
    this.leaving = input.leaving
    this.github = input.github
    this.ended = input.ended
    this.hangUp = input.hangUp
  }

  private say(id: CliCopyId, vars: Readonly<Record<string, string | number>> = {}): string {
    return said(id, this.account.platform, vars)
  }

  private refusal(reason: AccountRefusal, message: string | undefined, handle = ''): string {
    if (message) return message
    if (reason === 'last_device') return this.say('refused.last_device', { handle })
    return this.say(SAID_REASONS[reason] ?? 'refused.unknown')
  }

  /** The first turn. The caller seals the pane when this asks for anything. */
  start(wanted: string): LoginTurn {
    return this.leaving ? this.startLogout() : this.startLogin(normaliseUsername(wanted))
  }

  hold(release: () => void): void {
    this.release = release
    this.armIdle()
  }

  private armIdle(): void {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = null
    // Not while an act is out: a person at GitHub is not a person who walked away.
    if (this.closed || this.gone || this.flights > 0) return
    this.idle = setTimeout(() => this.timedOut(), this.deps.idleMs ?? IDLE_MS)
    this.idle.unref?.()
  }

  /**
   * NOBODY CAME BACK. The CLI is sitting at a hidden prompt, and the seal is what
   * makes it safe to type there, so the seal must not go first: somebody back
   * from lunch would type a password into a pane that is announcing it. So the
   * connection is ended, the CLI exits on that, and the seal goes when it has
   * (`close`). A client that ignores the hang-up gets a few seconds.
   */
  private timedOut(): void {
    this.hangUp()
    setTimeout(() => this.close(), this.deps.hangUpMs ?? HANG_UP_MS).unref?.()
  }

  /**
   * ONE ACT ON THE WIRE, and what the terminal going does to it.
   *
   * A code or a nod already sent cannot be called back: the registry may attach
   * this device and answer 201 whatever happens here. If that answer found the
   * minted key thrown away, the account would hold a device nothing can prove,
   * so the ladder is left standing until the act comes back. If it landed, the
   * machine IS signed in and the log says so; otherwise the ladder goes now.
   */
  private async flying(run: () => Promise<LoginTurn>): Promise<LoginTurn> {
    if (this.idle !== null) clearTimeout(this.idle)
    this.flights += 1
    try {
      return await run()
    } finally {
      this.flights -= 1
      if (this.gone && this.flights === 0 && !this.closed) this.left()
      else this.armIdle()
    }
  }

  private letGo(): void {
    this.release()
    this.release = () => undefined
  }

  private left(): void {
    this.finish(LOGIN_EXIT.failed, [], 'left before it finished')
  }

  private startLogin(wanted: string): LoginTurn {
    const who = this.account.who()
    if (who.username === null) {
      if (this.github) return this.askDevice()
      if (wanted === '') {
        this.stage = { at: 'username' }
        return { say: [], ask: { kind: 'text', prompt: this.say('ask.username') } }
      }
      return this.askPassword(wanted, 0, false, [])
    }
    if (wanted !== '' && wanted !== who.username) {
      return this.finish(LOGIN_EXIT.failed, [this.say('said.other-account', { handle: who.username, wanted })], null)
    }
    if (who.sessionLive) {
      return this.finish(
        LOGIN_EXIT.ok,
        [this.say('said.already', { handle: who.username, device: who.deviceName })],
        null
      )
    }
    if (who.mismatch !== null) {
      const sentence = machineCopy(registryMismatchSentence(who.mismatch), this.account.platform)
      return this.finish(LOGIN_EXIT.failed, [sentence], null)
    }
    if (this.github) return this.askDevice()
    if (who.passwordless) {
      return this.finish(LOGIN_EXIT.failed, [this.say('said.no-password', { handle: who.username })], null)
    }
    return this.askPassword(who.username, 0, true, [])
  }

  /** The CLI calls `wait` next, and that call starts the flow. */
  private askDevice(): LoginTurn {
    this.stage = { at: 'device' }
    return { say: [], wait: { other: false } }
  }

  private startLogout(): LoginTurn {
    const who = this.account.who()
    if (who.username === null) return this.finish(LOGIN_EXIT.ok, [this.say('said.not-signed-in')], null)
    // Leaving needs a live session to act under, and no password is the fix.
    if (!who.sessionLive) {
      const sentence = this.say('said.session-ended', { handle: who.username, device: who.deviceName })
      return this.finish(LOGIN_EXIT.failed, [sentence], null)
    }
    // The proof would be a browser trip, and this machine may have no browser.
    if (who.passwordless) {
      return this.finish(LOGIN_EXIT.failed, [this.say('said.logout-no-password', { handle: who.username })], null)
    }
    this.stage = { at: 'logout', username: who.username, tries: 0 }
    return {
      say: [],
      ask: { kind: 'hidden', prompt: this.say('ask.password-logout', { handle: who.username }) }
    }
  }

  private askPassword(username: string, tries: number, renew: boolean, say: readonly string[]): LoginTurn {
    this.stage = { at: 'password', username, tries, renew }
    return { say, ask: { kind: 'hidden', prompt: this.say('ask.password', { handle: username }) } }
  }

  /** Whatever was just asked has been answered. */
  answer(text: string): Promise<LoginTurn> {
    return this.flying(async () => this.respond(text))
  }

  private respond(text: string): Promise<LoginTurn> | LoginTurn {
    const stage = this.stage
    switch (stage.at) {
      case 'username':
        return this.askPassword(normaliseUsername(text), 0, false, [])
      case 'password':
        return this.tryPassword(stage, text)
      case 'handle':
        return this.tryHandle(stage, text)
      case 'logout':
        return this.tryLogout(stage, text)
      case 'rung':
        return this.pickRung(stage, text)
      case 'code':
        return this.tryCode(stage, text)
      default:
        return { say: [], exit: LOGIN_EXIT.failed }
    }
  }

  private async tryPassword(stage: Extract<Stage, { at: 'password' }>, password: string): Promise<LoginTurn> {
    const answer = stage.renew
      ? await this.account.resume(password)
      : await this.account.signIn({ username: stage.username, password })
    if (answer.ok) return this.landed()
    if (answer.reason === 'second_factor') return this.offerRungs(answer.step, answer.message)
    const sentence = this.refusal(answer.reason, answer.message)
    if (!isWrongPassword(answer.reason)) return this.finish(LOGIN_EXIT.failed, [sentence], answer.reason)
    const tries = stage.tries + 1
    if (tries >= PASSWORD_TRIES) {
      return this.finish(LOGIN_EXIT.failed, [sentence, this.say('said.too-many-passwords')], 'three wrong passwords')
    }
    return this.askPassword(stage.username, tries, stage.renew, [sentence])
  }

  private async tryLogout(stage: Extract<Stage, { at: 'logout' }>, password: string): Promise<LoginTurn> {
    const answer = await this.account.signOut(password)
    if (answer.ok) {
      this.deps.audit({ type: 'account.logout', terminalId: this.pane.id, details: `@${stage.username}` })
      return this.finish(LOGIN_EXIT.ok, [this.say('said.signed-out', { handle: stage.username })], null)
    }
    const sentence = this.refusal(answer.reason, answer.message, stage.username)
    const tries = stage.tries + 1
    if (!isWrongPassword(answer.reason) || tries >= PASSWORD_TRIES) {
      return this.finish(LOGIN_EXIT.failed, [sentence], answer.reason)
    }
    this.stage = { ...stage, tries }
    return {
      say: [sentence],
      ask: { kind: 'hidden', prompt: this.say('ask.password-logout', { handle: stage.username }) }
    }
  }

  /** The password was right and the account wants more. */
  private async offerRungs(step: SecondFactorStep, message: string | undefined): Promise<LoginTurn> {
    this.pending = step.pending
    // The terminal went while the password was in flight: nobody is here to
    // climb, and `flying` ends this as soon as it returns.
    if (this.gone) return { say: [] }
    const rungs = RUNG_ORDER.filter(
      (rung) => step.next.includes(rung) && (rung !== 'approve' || step.match !== undefined)
    )
    const say = [
      ...(message ? [message] : []),
      ...(step.next.includes('approve') && step.match === undefined ? [this.say('rung.no-match')] : []),
      ...(step.next.includes('passkey') && rungs.length > 0 ? [this.say('rung.no-passkey')] : [])
    ]
    if (rungs.length === 0) {
      const last = step.next.includes('passkey') ? 'rung.passkey-only' : 'rung.none'
      return this.finish(LOGIN_EXIT.failed, [...say, this.say(last)], 'no rung a terminal can climb')
    }
    const only = rungs.length === 1 ? rungs[0] : undefined
    return only === undefined ? this.choice(step, rungs, say) : this.climb(step, rungs, only, say)
  }

  private choice(step: SecondFactorStep, rungs: readonly Rung[], say: readonly string[]): LoginTurn {
    this.stage = { at: 'rung', step, rungs }
    const options = rungs.map((rung, at) => ({ key: String(at + 1), label: this.say(`rung.${rung}`) }))
    return { say, ask: { kind: 'choice', prompt: this.say('ask.choose'), options } }
  }

  private pickRung(stage: Extract<Stage, { at: 'rung' }>, text: string): Promise<LoginTurn> | LoginTurn {
    const picked = text.trim() === '' ? 1 : Number(text.trim())
    const rung = Number.isInteger(picked) ? stage.rungs[picked - 1] : undefined
    if (rung === undefined) return this.choice(stage.step, stage.rungs, [this.say('ask.choose-again')])
    return this.climb(stage.step, stage.rungs, rung, [])
  }

  private async climb(
    step: SecondFactorStep,
    rungs: readonly Rung[],
    rung: Rung,
    say: readonly string[]
  ): Promise<LoginTurn> {
    if (rung !== 'approve') return this.askCode(step, rungs, rung, say)
    const asked = await this.account.askApproval(step.pending)
    if (!asked.ok) return this.ladderRefused(step, rungs, asked.reason, asked.message)
    this.stage = { at: 'waiting', step, rungs }
    this.saidOffline = false
    const other = rungs.length > 1
    return {
      say: [
        ...say,
        this.say('approve.match', { match: step.match ?? '' }),
        this.say('approve.waiting'),
        this.say(other ? 'approve.hint' : 'approve.hint-alone')
      ],
      wait: { other }
    }
  }

  private askCode(
    step: SecondFactorStep,
    rungs: readonly Rung[],
    factor: TypedFactor,
    say: readonly string[]
  ): LoginTurn {
    this.stage = { at: 'code', step, rungs, factor }
    return { say, ask: { kind: 'hidden', prompt: this.say(`ask.${factor}`) } }
  }

  private async tryCode(stage: Extract<Stage, { at: 'code' }>, code: string): Promise<LoginTurn> {
    const answer = await this.account.climbCode(stage.step.pending, stage.factor, code)
    if (answer.ok) return this.landed()
    // Only a second_factor could be this, and a rung answers none.
    if (answer.reason === 'second_factor') return this.finish(LOGIN_EXIT.failed, [this.say('refused.unknown')], 'unknown')
    if (ladderIsOver(answer.reason)) return this.ladderRefused(stage.step, stage.rungs, answer.reason, answer.message)
    return this.askCode(stage.step, stage.rungs, stage.factor, [this.refusal(answer.reason, answer.message)])
  }

  private ladderRefused(
    step: SecondFactorStep,
    rungs: readonly Rung[],
    reason: AccountRefusal,
    message: string | undefined
  ): LoginTurn {
    const sentence = this.refusal(reason, message)
    if (ladderIsOver(reason)) {
      return this.finish(LOGIN_EXIT.failed, [sentence, this.say('said.start-again')], reason)
    }
    return this.choice(step, rungs, [sentence])
  }

  /** The approve rung's long half. One call per wait; `stop` ends it early. */
  wait(): Promise<LoginTurn> {
    const running = this.deviceTurn
    if (running !== null) {
      this.collected()
      return running
    }
    return this.flying(() => (this.stage.at === 'device' ? this.startDevice() : this.awaitNod()))
  }

  /**
   * THE DEVICE FLOW, IN TWO WAITS, because the code has to reach the screen while
   * the poll carries on. The first answers with the code; the second with the end.
   *
   * THE ENDING IS A FLIGHT OF ITS OWN, not the second wait's. A poll on the wire
   * cannot be called back, so if the terminal goes between the two waits the
   * ending still runs, and what came back is landed and written down.
   */
  private async startDevice(): Promise<LoginTurn> {
    const stop = new AbortController()
    this.stopWaiting = stop
    let shown: (code: DeviceCode) => void = () => undefined
    const coded = new Promise<DeviceCode>((resolve) => {
      shown = resolve
    })
    const answer = this.account.providerDevice((code) => shown(code), stop.signal)
    const ending = this.flying(async () => this.deviceEnded(await answer))
    this.deviceTurn = ending
    const code = await Promise.race([coded, ending.then(() => null)])
    if (code === null) {
      this.collected()
      return ending
    }
    return {
      say: [this.say('device.code', { url: code.verificationUri, code: code.userCode }), this.say('device.waiting')],
      wait: { other: false }
    }
  }

  /** The ending has somewhere to go, so the door can be handed back. */
  private collected(): void {
    this.deviceTurn = null
    if (this.uncollected) this.ended()
    this.uncollected = false
  }

  private deviceEnded(answer: ProviderSignInAnswer<unknown>): Promise<LoginTurn> | LoginTurn {
    this.stopWaiting = null
    if (answer.ok) return this.landed()
    if (answer.reason === 'second_factor') return this.offerRungs(answer.step, answer.message)
    if (this.gone) return { say: [] }
    if (answer.reason === 'new_identity') {
      this.naming = true
      return this.askHandle(answer.suggest, [this.say('said.new-identity')])
    }
    return this.finish(LOGIN_EXIT.failed, [this.refusal(answer.reason, answer.message)], answer.reason)
  }

  private askHandle(suggest: string, say: readonly string[]): LoginTurn {
    this.stage = { at: 'handle', suggest }
    const prompt = suggest === '' ? this.say('ask.handle-blank') : this.say('ask.handle', { suggest })
    return { say, ask: { kind: 'text', prompt } }
  }

  /** The handle is Cookrew's own: Enter takes the suggestion, a clash asks again. */
  private async tryHandle(stage: Extract<Stage, { at: 'handle' }>, text: string): Promise<LoginTurn> {
    const username = normaliseUsername(text) || stage.suggest
    if (username === '') return this.askHandle(stage.suggest, [])
    const answer = await this.account.providerClaim(username)
    if (answer.ok) {
      this.naming = false
      return this.landed()
    }
    if (this.gone) return { say: [] }
    if (answer.reason === 'taken') return this.askHandle(stage.suggest, [this.say('refused.handle-taken', { handle: username })])
    if (answer.reason === 'bad_username' || answer.reason === 'legacy') {
      return this.askHandle(stage.suggest, [this.refusal(answer.reason, answer.message)])
    }
    return this.finish(LOGIN_EXIT.failed, [this.refusal(answer.reason, answer.message)], answer.reason)
  }

  private async awaitNod(): Promise<LoginTurn> {
    const stage = this.stage
    if (stage.at !== 'waiting') return { say: [], exit: LOGIN_EXIT.failed }
    const stop = new AbortController()
    this.stopWaiting = stop
    const answer = await this.account.waitApproval(stage.step.pending, stop.signal)
    this.stopWaiting = null
    if (answer.ok) return this.landed()
    if (this.gone) return { say: [] }
    if (stop.signal.aborted) return this.choice(stage.step, stage.rungs, [])
    if (answer.reason === 'offline' || answer.reason === 'rate_limited') {
      // Not the end of the ladder: the pending is standing at the registry.
      await (this.deps.sleep ?? defaultSleep)(WAIT_RETRY_MS)
      const say = this.saidOffline ? [] : [this.say('approve.offline')]
      this.saidOffline = true
      return { say, wait: { other: stage.rungs.length > 1 } }
    }
    return this.ladderRefused(stage.step, stage.rungs, answer.reason, answer.message)
  }

  stop(): LoginTurn {
    this.stopWaiting?.abort()
    return { say: [] }
  }

  private async landed(): Promise<LoginTurn> {
    this.pending = null
    const who = this.account.who()
    const listed = await this.account.devices()
    // The name as cookrew.dev filed it, which is what its Devices list will
    // show. The one this machine sent is the fallback, and they normally agree.
    const filed = listed.ok ? listed.value.find((device) => device.id === who.deviceId)?.name : undefined
    const device = filed ?? who.deviceName
    const handle = who.username ?? ''
    const late = this.gone ? ', after the terminal left' : ''
    const via = this.github ? ' with GitHub' : ''
    this.deps.audit({ type: 'account.login', terminalId: this.pane.id, details: `@${handle} on ${device}${via}${late}` })
    const said = [this.say('said.signed-in', { handle, device })]
    const unlocked = this.github && who.passcodePending
    return this.finish(LOGIN_EXIT.ok, unlocked ? [...said, this.say('said.passcode-next')] : said, null)
  }

  private get closed(): boolean {
    return this.stage.at === 'over'
  }

  /** The end, however it came. `failure` goes in the event log; null writes nothing. */
  private finish(exit: number, say: readonly string[], failure: string | null): LoginTurn {
    this.stage = { at: 'over' }
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = null
    if (this.pending !== null) this.account.abandon(this.pending)
    this.pending = null
    if (this.naming) this.account.abandonClaim()
    this.naming = false
    this.letGo()
    if (this.deviceTurn !== null && !this.gone) this.uncollected = true
    else this.ended()
    if (failure !== null) {
      this.deps.audit({ type: 'account.login-refused', terminalId: this.pane.id, details: failure })
    }
    return { say, exit }
  }

  /**
   * The connection went, or nobody came back to the prompt. Nothing is left
   * waiting and the keys are free at once; the ladder follows the moment
   * nothing is in flight (`flying`).
   */
  close(): void {
    this.collected()
    if (this.closed || this.gone) return
    this.gone = true
    this.stopWaiting?.abort()
    this.letGo()
    if (this.flights === 0) this.left()
  }
}

/**
 * THE DOOR: who may start, and which connection a turn belongs to.
 *
 * ONE CONVERSATION AT A TIME, AND IT BELONGS TO ITS CONNECTION. Two ladders on
 * one machine are two keys and only one could ever be the file. A turn from any
 * other connection is refused, so what is held here cannot be finished by a
 * process that did not start it, and the connection closing ends it: a Ctrl-C
 * stops a wait, so no poll is left running to sign this machine in later,
 * unseen. An act already on the wire finishes, and is written down as such.
 */
export class LoginDoor {
  private readonly deps: LoginDoorDeps
  private held: { connection: LoginConnection; conversation: Conversation } | null = null

  constructor(deps: LoginDoorDeps) {
    this.deps = deps
  }

  async handle(request: CliRequest, secret: string | undefined, connection: LoginConnection): Promise<string> {
    const [verb, wanted] = request.args
    if (verb === 'open') {
      return JSON.stringify(this.open(request, typeof wanted === 'string' ? wanted : '', connection))
    }
    const conversation = this.held?.connection === connection ? this.held.conversation : null
    if (conversation === null) throw new LoginRefused(this.line('gate.not-open'), LOGIN_EXIT.refused)
    if (verb === 'answer') return JSON.stringify(await conversation.answer(secret ?? ''))
    if (verb === 'wait') return JSON.stringify(await conversation.wait())
    if (verb === 'stop') return JSON.stringify(conversation.stop())
    throw new LoginRefused(this.line('gate.not-open'), LOGIN_EXIT.refused)
  }

  private line(id: CliCopyId): string {
    return said(id, this.deps.account()?.platform ?? process.platform)
  }

  private refuse(request: CliRequest, terminalId: string, id: CliCopyId, why: string): never {
    this.deps.audit({ type: 'account.login-refused', terminalId, details: `${request.cmd}: ${why}` })
    throw new LoginRefused(this.line(id), LOGIN_EXIT.refused)
  }

  /** The pane, or the refusal. Every refusal is written down. */
  private admit(request: CliRequest): TerminalNodeData {
    let pane: TerminalNodeData
    try {
      pane = this.deps.ownerPane(request)
    } catch (error) {
      const why = error instanceof Error ? error.message : 'not an owner pane'
      this.deps.audit({ type: 'account.login-refused', terminalId: request.terminalId, details: `${request.cmd}: ${why}` })
      throw error
    }
    if (request.sessionId) this.refuse(request, pane.id, 'gate.agent-caller', 'run by an agent')
    if (this.deps.agentBusy(pane.id)) this.refuse(request, pane.id, 'gate.agent-busy', 'the agent here is mid-turn')
    if (this.deps.driven(pane.id)) this.refuse(request, pane.id, 'gate.driven', 'typed here by something other than a keyboard')
    if (request.flags.tty !== true) this.refuse(request, pane.id, 'gate.no-keyboard', 'no terminal')
    if (this.held !== null) this.refuse(request, pane.id, 'gate.held', 'another sign-in is open')
    return pane
  }

  private open(request: CliRequest, wanted: string, connection: LoginConnection): LoginTurn {
    const pane = this.admit(request)
    const account = this.deps.account()
    if (account === null) this.refuse(request, pane.id, 'gate.no-door', 'no account wired')
    const conversation = new Conversation({
      account,
      deps: this.deps,
      pane,
      leaving: request.cmd === 'logout',
      github: request.flags.github === true,
      ended: () => {
        if (this.held?.conversation === conversation) this.held = null
      },
      hangUp: () => connection.end()
    })
    this.held = { connection, conversation }
    connection.once('close', () => conversation.close())
    try {
      const first = conversation.start(wanted)
      // From before the first prompt, which on a device flow comes after a wait.
      if (first.ask !== undefined || first.wait !== undefined) conversation.hold(this.deps.seal(pane.id))
      return first
    } catch (error) {
      // Nothing is open, so nothing must go on saying so.
      this.held = null
      throw error
    }
  }

  /** `cookrew whoami`: a read, so an agent may ask. The owner-pane rule still holds. */
  whoami(request: CliRequest): string {
    this.deps.ownerPane(request)
    const account = this.deps.account()
    const platform = account?.platform ?? process.platform
    if (account === null) throw new LoginRefused(said('gate.no-door', platform), LOGIN_EXIT.refused)
    const who = account.who()
    if (who.username === null) throw new LoginRefused(said('said.not-signed-in', platform), LOGIN_EXIT.failed)
    const vars = { handle: who.username, device: who.deviceName, registry: who.registry ?? 'cookrew.dev' }
    if (!who.sessionLive) throw new LoginRefused(said('said.session-ended', platform, vars), LOGIN_EXIT.failed)
    return said('said.whoami', platform, vars)
  }
}
