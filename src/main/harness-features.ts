// OPTIONAL HARNESS FEATURES (harness-integration-contract rule 9): the
// features only some harnesses have, declared in one table — every feature ×
// every harness, a `true` or an `unsupported(reason)`. Call sites ask
// `harnessHas(feature, command)` instead of `isClaudeCommand(command)`, so a
// new harness is refused BY DECLARATION with a reason, never by the accident
// of not being Claude; and claiming a feature needs an implementation behind
// it (tests/harness-matrix.test.ts pins which harness implements which).

import type { HarnessId } from '../shared/harness-catalog'
import { isUnsupported, supportedIds, unsupported, unsupportedReason, type PerHarness } from '../shared/harness-support'
import { harnessFor } from './harness'

export type OptionalFeature =
  /** Pre-answer the first-boot dialogs (folder trust, bypass consent, onboarding) so a card never stalls on them. */
  | 'firstBootPrep'
  /** A card whose session was filed under another directory moves there before it resumes. */
  | 'sessionCwdRepair'
  /** An idle agent sleeps and wakes on demand without losing its session. */
  | 'idleSleep'
  /** A session another live process holds is forked rather than resumed (resume would exit at once). */
  | 'heldSessionFork'
  /** A saved role resumes a copy of the checkpoint conversation. */
  | 'roleSessionCopy'
  /** Fork from turn N with the real context (a truncated copy under a fresh id), not a text replay. */
  | 'nativeFork'
  /** Cut the conversation back to turn N in place. */
  | 'restore'
  /** One conversation spans several session files (/clear, compaction), and the rail keeps the earlier ones. */
  | 'sessionLineage'
  /** The card's RTE dial: pick the route per card from the gateway's catalog. */
  | 'routeDial'
  /** The effort dial offers the route's own levels for the routed model. */
  | 'routeEffortChoices'

const ONLY_CLAUDE = (reason: string): PerHarness<true> => ({
  claude: true,
  codex: unsupported(reason),
  opencode: unsupported(reason),
  pi: unsupported(reason),
  agy: unsupported(reason),
  devin: unsupported(reason),
  dsh: unsupported(reason)
})

export const OPTIONAL_FEATURES: Readonly<Record<OptionalFeature, PerHarness<true>>> = {
  firstBootPrep: {
    ...ONLY_CLAUDE('it asks nothing Cookrew knows how to pre-answer'),
    // Folder trust rides on agy's own launch line (harness-launch.ts · agySessionLine).
    agy: unsupported('its folder trust is granted on its launch line, for that session only'),
    // Folder trust is skipped on its launch line (harness-launch.ts · devinSessionLine).
    devin: unsupported('its folder trust is skipped on its launch line, for that session only'),
    dsh: unsupported('it asks nothing at its first boot; Cookrew\u2019s ACP host opens its session')
  },
  sessionCwdRepair: ONLY_CLAUDE('its session address does not depend on the card directory'),
  idleSleep: ONLY_CLAUDE('no process record proves it idle and resumable'),
  heldSessionFork: ONLY_CLAUDE('no live-holder record to ask'),
  roleSessionCopy: ONLY_CLAUDE('no format-aware session copy exists for it'),
  nativeFork: ONLY_CLAUDE('no format-aware session truncation exists for it; a fork replays the turns as text'),
  // The sentence restore-plan.ts says on the card.
  restore: ONLY_CLAUDE('its rollout format has no truncation path'),
  sessionLineage: ONLY_CLAUDE('one session file per pane: nothing to chain'),
  routeDial: {
    claude: true,
    codex: true,
    opencode: true,
    // NOT_ROUTABLE_REASON (shared/route-view.ts) says the same on R1's tick.
    pi: unsupported('pi takes a provider only from its global models.json'),
    agy: unsupported('agy takes its model only from its Google sign-in or the Gemini API; a route through Magpie is not proven yet'),
    devin: unsupported('Devin runs on its own Cognition account: no gateway or own key reaches it'),
    dsh: true
  },
  routeEffortChoices: ONLY_CLAUDE('its effort dial reads only the harness’s own levels')
}

/** Does the harness this command runs have the feature? A plain shell has none. */
export function harnessHas(feature: OptionalFeature, command: string): boolean {
  const harness = harnessFor(command)
  return harness !== null && !isUnsupported(OPTIONAL_FEATURES[feature][harness.id])
}

/** Why a harness lacks a feature, or null when it has it. */
export function lacksBecause(feature: OptionalFeature, id: HarnessId): string | null {
  return unsupportedReason(OPTIONAL_FEATURES[feature], id)
}

/** feature → the harnesses that have it, in catalog order (the matrix test, docs). */
export function featureMatrix(): Record<OptionalFeature, HarnessId[]> {
  return Object.fromEntries(
    (Object.keys(OPTIONAL_FEATURES) as OptionalFeature[]).map((feature) => [feature, supportedIds(OPTIONAL_FEATURES[feature])])
  ) as Record<OptionalFeature, HarnessId[]>
}
