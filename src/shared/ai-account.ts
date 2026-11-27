import type { FirstRunStage } from './first-run'
import type { RouteModel, RouteState } from './route'
import { supportFor, unsupported, type PerHarness } from './harness-support'

/**
 * HAS THIS PERSON AN AI ACCOUNT AN AGENT CAN RUN ON? One answer for the first
 * run's tool check, the Routing panel and the nudge a launch shows when the
 * answer is no. Pure: the renderer feeds it the route state and whether the
 * person's own endpoint is on.
 *
 * Four ways count, in the order an agent would take them: Claude Code or Codex
 * signed in by itself; the person's own endpoint (agent-access.ts); or Magpie,
 * which counts only when it runs AND has a default model, since a new card goes
 * through Magpie only then (route program: the default is picked, never inferred).
 */

export type AccountRoute = Pick<RouteState, 'status' | 'defaultModel' | 'models' | 'harnesses' | 'withheld'>

export interface AccountFacts {
  readonly route: AccountRoute | null
  /** The person's own endpoint is saved. */
  readonly endpoint: boolean
}

export type AccountVia = 'claude' | 'codex' | 'endpoint' | 'magpie'

function signedIn(route: AccountRoute | null, id: 'claude' | 'codex'): boolean {
  const row = route?.harnesses.find((h) => h.id === id)
  return row?.installed === true && row.signedIn === true
}

export function accountVia({ route, endpoint }: AccountFacts): AccountVia | null {
  if (signedIn(route, 'claude')) return 'claude'
  if (signedIn(route, 'codex')) return 'codex'
  if (endpoint) return 'endpoint'
  if (route?.status === 'online' && route.defaultModel !== null) return 'magpie'
  return null
}

/** Unknown is not no account: a restricted route can hide the Magpie default. */
export function accountKnowledge(facts: AccountFacts): { via: AccountVia | null; known: boolean } {
  const via = accountVia(facts)
  const hidden = facts.route?.withheld?.defaultModel || facts.route?.withheld?.endpointInventory || facts.route?.withheld?.providerData
  return { via, known: via !== null || (facts.route !== null && !hidden) }
}

/**
 * Magpie is set up but not answering yet: at login it may start after Cookrew. Not an
 * account to run on now, and not a reason to say there is none.
 */
export function accountStarting(route: AccountRoute | null): boolean {
  return route?.status === 'offline' && route.defaultModel !== null
}

/** Magpie has something to run on and nothing is picked: the one step left. */
export function needsDefault(route: AccountRoute | null): boolean {
  return route?.status === 'online' && !route.withheld?.defaultModel && !route.withheld?.endpointInventory && !route.withheld?.providerData && route.defaultModel === null && route.models.length > 0
}

const isGroup = (m: RouteModel): boolean => m.group || m.id.startsWith('group/') || m.id.includes('/group/')

/** What the default may be, routing groups first: a group follows quota where a model cannot. */
export function defaultChoices(models: readonly RouteModel[]): RouteModel[] {
  return [...models.filter(isGroup), ...models.filter((m) => !isGroup(m))]
}

export interface SubscriptionLine {
  readonly id: 'claude' | 'chatgpt'
  readonly label: string
  readonly line: string
}

const MAGPIE_SIGN_INS: readonly SubscriptionLine[] = [
  { id: 'claude', label: 'Claude', line: 'magpie accounts add claude' },
  { id: 'chatgpt', label: 'ChatGPT', line: 'magpie accounts add codex' }
]

/**
 * A subscription signs in to Magpie when Magpie is here, so every agent can use
 * it; without Magpie, each tool signs itself in, and only a tool that is here.
 */
export function subscriptionLines(route: AccountRoute | null): readonly SubscriptionLine[] {
  if (route === null) return []
  if (route.status !== 'absent') return MAGPIE_SIGN_INS
  return route.harnesses.flatMap((h): SubscriptionLine[] => {
    if (!h.installed || h.loginLine === null) return []
    const subscription = supportFor(OWN_SUBSCRIPTION, h.id)
    return subscription ? [{ ...subscription, line: h.loginLine }] : []
  })
}

/** The subscription each harness signs itself in to when Magpie is not here. */
export const OWN_SUBSCRIPTION: PerHarness<Omit<SubscriptionLine, 'line'>> = {
  claude: { id: 'claude', label: 'Claude' },
  codex: { id: 'chatgpt', label: 'ChatGPT' },
  opencode: unsupported('signs in to many providers, none of them a subscription first-run offers'),
  pi: unsupported('has no sign-in of its own'),
  agy: unsupported('signs in with a Google account in its own first run'),
  devin: unsupported('signs in to Cognition with `devin auth login`, which the tool check offers'),
  dsh: unsupported('it runs on a DeepSeek key or the gateway, with no sign-in of its own'),
  alma: unsupported('its sign-ins belong to the app (Settings › Providers)')
}

export interface GuideFacts {
  readonly stage: FirstRunStage
  readonly via: AccountVia | null
  /** The facts have had time to arrive: Claude's Keychain sign-in answers late. */
  readonly settled: boolean
  readonly dismissed: boolean
}

/** The launch nudge: past the first run's own screens, with nothing to run on. */
export function guideVisible({ stage, via, settled, dismissed }: GuideFacts): boolean {
  return stage !== 'preflight' && stage !== 'task' && settled && via === null && !dismissed
}
