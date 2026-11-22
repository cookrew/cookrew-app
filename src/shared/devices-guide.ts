import type { LiveValues } from './launch-settings'
import type { RouteState } from './route'
import { codexInstallLine } from './route-lines'

/**
 * YOUR COMPUTERS, ONE MODEL LOGIN (lane Magpie, new-user guide). Four steps, the
 * same in the first run and in Launch settings:
 *
 *   1. computers: this computer signed in, and the others added to the account
 *      (the account sheet's Add a computer, a one-time join code);
 *   2. agents: Claude Code or Codex on each computer, one runnable line each,
 *      chosen by that computer's own system;
 *   3. model: one computer logs into a model, through Magpie;
 *   4. use: every other computer uses that one's Magpie, sealed
 *      (main/magpie-remote/), once both switches are on.
 *
 * A step is marked done only on what this computer can see; nothing is assumed.
 */

export type GuideOs = 'darwin' | 'linux' | 'win32' | 'other'

export interface GuideDesktop {
  readonly id: string
  readonly name: string
  readonly online: boolean
  /** Set when this computer uses that one's Magpie. */
  readonly providerId: string | null
  readonly os: GuideOs | null
  readonly arch: string | null
}

export interface HarnessLine {
  readonly harness: 'claude' | 'codex'
  readonly name: string
  /** A line that runs as it stands on that computer; null where there is none to give. */
  readonly line: string | null
}

const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

/** The install lines for a computer, by its own system: Codex from its release, so no npm is needed. */
export function harnessLines(os: GuideOs | null, arch: string | null): HarnessLine[] {
  if (os === null || os === 'other') return []
  if (os === 'win32') {
    return [
      { harness: 'claude', name: 'Claude Code', line: null },
      { harness: 'codex', name: 'Codex', line: null }
    ]
  }
  return [
    { harness: 'claude', name: 'Claude Code', line: CLAUDE_INSTALL },
    { harness: 'codex', name: 'Codex', line: arch === null ? null : codexInstallLine(os, arch) }
  ]
}

export type GuideStepId = 'computers' | 'agents' | 'model' | 'use'

export interface GuideStep {
  readonly id: GuideStepId
  readonly done: boolean | null
  /** What stands in the way, when something does. */
  readonly blocked: string | null
}

export interface GuideFacts {
  readonly signedIn: boolean
  /** The account's OTHER desktops. */
  readonly desktops: readonly GuideDesktop[]
  /** This computer's Magpie has a model to route to. */
  readonly modelHere: boolean | null
  readonly switches: LiveValues | null
}

export function modelHereForRoute(route: RouteState | null): boolean | null {
  // Not read yet (or not readable) is "no model here yet", as before schema 2.
  // Only a host that says it withheld the catalog makes the answer unknown.
  if (route === null) return false
  if (route.withheld?.endpointInventory || route.withheld?.providerData) return null
  return route.status === 'online' && route.models.length > 0
}

export function guideSteps(facts: GuideFacts): GuideStep[] {
  const remoteOn = facts.switches?.magpie === true && facts.switches.magpieRemote === true
  const used = facts.desktops.some((d) => d.providerId !== null)
  return [
    { id: 'computers', done: facts.signedIn && facts.desktops.length > 0, blocked: facts.signedIn ? null : DEVICES_COPY.SIGN_IN_FIRST },
    // An agent on another computer cannot be seen from here: this step is never marked done for it.
    { id: 'agents', done: false, blocked: null },
    { id: 'model', done: used ? true : facts.modelHere, blocked: null },
    { id: 'use', done: used, blocked: remoteOn ? null : DEVICES_COPY.SWITCHES_FIRST }
  ]
}

export const DEVICES_COPY = {
  HEAD: 'Your computers',
  LEDE: 'Log into a model on one computer. Every other computer of yours uses it, through an encrypted link only your computers can read.',
  SIGN_IN_FIRST: 'Sign in first: your computers find each other through your account.',
  SWITCHES_FIRST: 'Turn on Magpie and Magpie remote in Launch settings, here and on the computer that has the model.',
  STEP_COMPUTERS: '1 · Add your computers',
  STEP_COMPUTERS_DOES: 'Sign in to the same account on each one. Add a computer gives a one-time code to type on the new one.',
  ADD: 'Add a computer',
  SIGN_IN: 'Sign in',
  THIS: 'This computer',
  NONE: 'No other computer on this account yet.',
  ONLINE: 'online',
  OFFLINE: 'offline',
  STEP_AGENTS: '2 · Put an agent on each',
  STEP_AGENTS_DOES: 'Run one of these on that computer, in any terminal. Nothing in them is a key.',
  NO_LINE: 'Install it by hand on this system.',
  COPY: 'Copy',
  COPIED: 'Copied',
  RUN_HERE: 'Run here',
  STEP_MODEL: '3 · Log into a model on one computer',
  STEP_MODEL_DOES: 'Pick one computer, usually the one that is always on, and connect an AI account there. The others do not need one.',
  MODEL_ABOVE: 'On that computer, use Connect an AI account above.',
  MODEL_ROUTING: 'On that computer, open Routing and connect an AI account.',
  STEP_USE: '4 · Use it from the others',
  STEP_USE_DOES: 'On each other computer, press Use its Magpie. It asks that computer for a key of its own, with a daily cap; nobody copies a key.',
  USE: 'Use its Magpie',
  USING: (providerId: string): string => `In use · models as ${providerId}/…`,
  CONNECTING: 'Connecting…',
  STOP: 'Stop using',
  NOT_SEALED: 'This computer has no keychain, so the key from the other computer is kept in a file only you can read, not encrypted.',
  NO_FORWARDER: 'Another program holds port 3428 on this computer, so other computers’ Magpies cannot be used until it is free.'
} as const
