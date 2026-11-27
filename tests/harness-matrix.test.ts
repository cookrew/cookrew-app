// PERMANENT feature × harness gate (harness-integration-contract rule 9,
// gates G8–G10). Every per-harness feature is one table keyed by every
// catalog id; TypeScript refuses a missing key, and this suite refuses what
// types cannot see: a table built with a cast, an unsupported entry with no
// reason, a support change nobody meant, a copy that still resumes its
// source. A new harness is added by filling every row here — never by
// loosening one.

import { describe, expect, it } from 'vitest'
import { HARNESS_CARDS, HARNESS_IDS, HARNESS_NAMES, harnessOfCommand, harnessOfPreset, isHarnessId } from '../src/shared/harness-catalog'
import { GATEWAY_MODELS_IN_TUNE, harnessFlag, LINE_REBUILT_ON_SEND } from '../src/shared/harness-ui'
import { agentKind, herdrAgentKind } from '../src/main/herdr-host-multiplexer'
import { isUnsupported, supportedIds, unsupported, type PerHarness } from '../src/shared/harness-support'
import { copiedSessionBindings, HARNESS_BY_ID, HARNESSES, harnessFor, SESSION_FIELDS, withoutSessionFlags } from '../src/main/harness'
import { featureMatrix, lacksBecause, OPTIONAL_FEATURES } from '../src/main/harness-features'
import { HARNESS_INPUT } from '../src/main/harness-input'
import { EXACT_RESTORE, SESSION_ON_DISK } from '../src/main/recover-gate'
import { SHARED_MCP_ARGS } from '../src/main/route/shared-mcp'
import { OWN_ENDPOINT } from '../src/main/agent-access'
import { LAUNCH_OFFERS } from '../src/main/launch-offers'
import { SESSION_CARRY } from '../src/main/session-move'
import { HARNESS_FACTS } from '../src/main/route/setup'
import { ROUTABLE } from '../src/main/route-env'
import { NOT_ROUTABLE_REASON } from '../src/shared/route-view'
import { ROUTE_OVERRIDES } from '../src/shared/launch-tune'
import { LAUNCH_LINE } from '../src/main/harness-launch'
import { OWN_SUBSCRIPTION } from '../src/shared/ai-account'
import { FIRST_RUN_AGENTS, FIRST_RUN_SIGN_IN, HARNESS_INSTALL_FIX, UNKNOWN_FACTS } from '../src/shared/preflight'

const TABLES: Record<string, Readonly<Record<string, unknown>>> = {
  'registry (harness.ts)': HARNESS_BY_ID,
  'catalog cards': HARNESS_CARDS,
  'catalog names': HARNESS_NAMES,
  'exact-context gate (recover-gate.ts)': EXACT_RESTORE,
  'session on disk (recover-gate.ts)': SESSION_ON_DISK,
  'typed input (harness-input.ts)': HARNESS_INPUT,
  'shared MCP hub (route/shared-mcp.ts)': SHARED_MCP_ARGS,
  'own endpoint (agent-access.ts)': OWN_ENDPOINT,
  'launch offers (launch-offers.ts)': LAUNCH_OFFERS,
  'session move (session-move.ts)': SESSION_CARRY,
  'routable (route-env.ts)': ROUTABLE,
  'not-routable reason (route-view.ts)': NOT_ROUTABLE_REASON,
  'route overrides (launch-tune.ts)': ROUTE_OVERRIDES,
  'own subscription (ai-account.ts)': OWN_SUBSCRIPTION,
  'line rebuilt on send (harness-ui.ts)': LINE_REBUILT_ON_SEND,
  'launch line (harness-launch.ts)': LAUNCH_LINE,
  'first-run install fix (preflight.ts)': HARNESS_INSTALL_FIX,
  'first-run sign-in (preflight.ts)': FIRST_RUN_SIGN_IN,
  'gateway models in the tune dial (harness-ui.ts)': GATEWAY_MODELS_IN_TUNE,
  ...Object.fromEntries(Object.entries(OPTIONAL_FEATURES).map(([feature, table]) => [`optional: ${feature}`, table]))
}

describe('G8 · every feature table declares every harness', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    it(`${name}: exactly the catalog ids, no more, no fewer`, () => {
      expect(Object.keys(table).sort()).toEqual([...HARNESS_IDS].sort())
    })
  }

  it('the registry lists every catalog harness once, in catalog order', () => {
    expect(HARNESSES.map((h) => h.id)).toEqual([...HARNESS_IDS])
    for (const id of HARNESS_IDS) expect(HARNESS_BY_ID[id].id).toBe(id)
  })

  it('install facts derive from the catalog, one row per harness', () => {
    expect(HARNESS_FACTS.map((f) => f.id)).toEqual([...HARNESS_IDS])
    for (const facts of HARNESS_FACTS) {
      expect(facts.name).toBe(HARNESS_CARDS[facts.id].name)
      expect(facts.bin).toBe(HARNESS_CARDS[facts.id].bin)
    }
  })

  it('every unsupported entry carries a reason a card can show', () => {
    for (const table of Object.values(TABLES)) {
      for (const entry of Object.values(table)) {
        if (isUnsupported(entry)) expect(entry.unsupported.trim().length).toBeGreaterThan(10)
      }
    }
    expect(() => unsupported('  ')).toThrow()
  })

  it('first run lists every harness exactly once, and knows nothing of each until asked', () => {
    expect([...FIRST_RUN_AGENTS].sort()).toEqual([...HARNESS_IDS].sort())
    for (const id of HARNESS_IDS) expect(UNKNOWN_FACTS[id]).toBe('unknown')
  })

  it('wire values are checked against the catalog', () => {
    for (const id of HARNESS_IDS) expect(isHarnessId(id)).toBe(true)
    for (const bad of ['', 'shell', 'Claude Code', '../claude', null, 3]) expect(isHarnessId(bad)).toBe(false)
  })
})

describe('G9 · the support matrix changes only on purpose', () => {
  // Pinned: turning a feature on or off for a harness is a decision, made
  // here, with the implementation that backs it in the same change.
  it('optional features', () => {
    expect(featureMatrix()).toEqual({
      firstBootPrep: ['claude'],
      sessionCwdRepair: ['claude'],
      idleSleep: ['claude'],
      heldSessionFork: ['claude'],
      roleSessionCopy: ['claude'],
      nativeFork: ['claude'],
      restore: ['claude'],
      sessionLineage: ['claude'],
      routeDial: ['claude', 'codex', 'opencode', 'dsh'],
      routeEffortChoices: ['claude']
    })
  })

  it('per-process plumbing', () => {
    const ids = (table: PerHarness<unknown>): string[] => supportedIds(table)
    expect(ids(SHARED_MCP_ARGS)).toEqual(['claude', 'codex', 'dsh'])
    expect(ids(OWN_ENDPOINT)).toEqual(['claude', 'codex', 'pi', 'dsh'])
    expect(ids(SESSION_ON_DISK)).toEqual(['claude', 'codex'])
    expect(ids(OWN_SUBSCRIPTION)).toEqual(['claude', 'codex'])
    expect(ids(FIRST_RUN_SIGN_IN)).toEqual(['claude', 'codex', 'devin'])
  })

  it('Claude keeps every optional feature (the baseline never regresses, like G2)', () => {
    for (const [feature, table] of Object.entries(OPTIONAL_FEATURES)) {
      expect(isUnsupported(table.claude), feature).toBe(false)
    }
  })

  it('the route dial and R1 give the same reason for a harness the gateway cannot carry', () => {
    for (const id of HARNESS_IDS) {
      expect(lacksBecause('routeDial', id)).toBe(NOT_ROUTABLE_REASON[id])
    }
  })

  it('a strategy whose implementation is one harness’s own code is claimed by that harness alone', () => {
    // mintedLaunchLine is Claude's resolver, exclusiveDirLaunchLine is pi-bind:
    // a second harness on either must generalize the implementation first.
    // 'pid-held' is generic — any harness that names a resolver gets it.
    const byKind = (kind: string): string[] => HARNESSES.filter((h) => h.bind.kind === kind).map((h) => h.id)
    expect(byKind('minted')).toEqual(['claude'])
    expect(byKind('exclusive-dir')).toEqual(['pi'])
    for (const h of HARNESSES) {
      if (h.bind.kind === 'pid-held') expect(typeof h.bind.resolveByPid).toBe('function')
    }
  })

  it('a session file means a trace parser too: the drawer and the rail read the same file', () => {
    for (const h of HARNESSES) {
      expect(h.traceParser !== undefined, h.id).toBe(h.turns === 'file')
    }
  })
})

describe('G10 · a copy never resumes its source', () => {
  it('a copied node clears every harness session field, and a cut carries every one', () => {
    expect([...SESSION_FIELDS].sort()).toEqual(HARNESSES.map((h) => h.sessionField).sort())
    const bound = Object.fromEntries(SESSION_FIELDS.map((field) => [field, `ref-${field}`]))
    expect(Object.values(copiedSessionBindings(bound))).toEqual(SESSION_FIELDS.map(() => null))
    expect(copiedSessionBindings(bound, true)).toEqual(bound)
  })

  const KEYS: Record<string, string> = {
    claude: '5e55a0de-0000-4000-8000-0000000000aa',
    codex: '5e55a0de-0000-4000-8000-0000000000bb',
    opencode: 'ses_abcDEF123',
    pi: 'abcdef12-3456-4789-8abc-def012345678',
    agy: '73f44614-99dc-4b12-a26c-92c3a56c594e',
    devin: 'wary-seeker',
    dsh: 'addff6fc-dbb7-4d65-9721-250105b33631',
    alma: 'mwzbq7jibffmx6d3ua3'
  }

  for (const id of HARNESS_IDS) {
    it(`${id}: stripping a resumed line drops the session it resumed`, () => {
      const harness = HARNESS_BY_ID[id]
      const base = `${HARNESS_CARDS[id].bin} --model m`
      const key = KEYS[id]
      expect(harness.resumeKey(key), 'fixture key must be valid').not.toBeNull()
      const resumed = harness.resumeCommand(base, key, { terminalId: 'term-1', cwd: '/work/repo' })
      expect(resumed).toContain(key)
      const copy = withoutSessionFlags(resumed)
      expect(copy).not.toContain(key)
      expect(copy.startsWith(HARNESS_CARDS[id].bin)).toBe(true)
      expect(copy).toContain('--model m')
    })
  }
})

describe('preset names draw their harness', () => {
  it('each catalog preset name maps to its own harness, and a custom preset to none', () => {
    for (const id of HARNESS_IDS) expect(harnessOfPreset(HARNESS_NAMES[id])).toBe(id)
    expect(harnessOfPreset('Pi agent')).toBe('pi')
    expect(harnessOfPreset('Pipeline')).toBeNull()
    expect(harnessOfPreset('Shell')).toBeNull()
    expect(harnessOfPreset(null)).toBeNull()
  })
})

describe('one command matcher, main and renderer alike', () => {
  const LINES = [
    'claude --permission-mode bypassPermissions',
    '  codex resume 5e55a0de-0000-4000-8000-0000000000bb',
    'opencode --session ses_abc',
    'pi --session-dir /x',
    '/Users/me/.cookrew/bin/qwen-pi --model q',
    'pipeline run',
    'zsh',
    '',
    'claudex',
    'codexx'
  ]

  it('the registry and the catalog name the same harness for every launch line', () => {
    for (const line of LINES) expect(harnessOfCommand(line), line).toBe(harnessFor(line)?.id ?? null)
  })

  it('herdr is told the kind its detector knows; the process check keeps the binary', () => {
    expect(herdrAgentKind('/Users/me/.cookrew/bin/qwen-pi --model q')).toBe('pi')
    expect(agentKind('/Users/me/.cookrew/bin/qwen-pi --model q')).toBe('qwen-pi')
    for (const id of HARNESS_IDS) expect(herdrAgentKind(`${HARNESS_CARDS[id].bin} --x`)).toBe(HARNESS_CARDS[id].herdrKind)
    expect(herdrAgentKind('/opt/homebrew/bin/codex resume')).toBe('codex')
    expect(herdrAgentKind('zsh')).toBe('zsh')
    expect(herdrAgentKind('')).toBe('shell')
  })

  it('renderer tables answer false for anything that is not a harness', () => {
    for (const value of [null, undefined, 'shell', 'other', 'Codex', 3]) {
      expect(harnessFlag(LINE_REBUILT_ON_SEND, value)).toBe(false)
    }
    expect(harnessFlag(LINE_REBUILT_ON_SEND, 'codex')).toBe(true)
    expect(supportedIdsOf(LINE_REBUILT_ON_SEND)).toEqual(['codex'])
    expect(supportedIdsOf(GATEWAY_MODELS_IN_TUNE)).toEqual(['claude'])
  })
})

function supportedIdsOf(table: Readonly<Record<string, boolean>>): string[] {
  return HARNESS_IDS.filter((id) => table[id])
}
