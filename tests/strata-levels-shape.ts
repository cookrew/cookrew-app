// Runtime shape checks for what crosses the wire (src/shared/strata.ts):
// EXACT keys — a field the contract does not name fails as surely as a
// missing one — and the value types the contract gives each.
import { expect } from 'vitest'
import { STRATA_LINE_MAX } from '../src/shared/strata'

type Check = (value: unknown, path: string) => void

const fail = (path: string, what: string, value: unknown): never => {
  throw new Error(`${path}: expected ${what}, got ${JSON.stringify(value)}`)
}

const str: Check = (v, p) => void (typeof v === 'string' || fail(p, 'string', v))
const num: Check = (v, p) => void ((typeof v === 'number' && Number.isFinite(v)) || fail(p, 'number', v))
const bool: Check = (v, p) => void (typeof v === 'boolean' || fail(p, 'boolean', v))
const nullable = (check: Check): Check => (v, p) => (v === null ? undefined : check(v, p))
const oneOf = (...allowed: unknown[]): Check => (v, p) => void (allowed.includes(v) || fail(p, `one of ${allowed.join('|')}`, v))
const array = (check: Check): Check => (v, p) => (Array.isArray(v) ? v.forEach((item, i) => check(item, `${p}[${i}]`)) : fail(p, 'array', v))
const textLine: Check = (v, p) => {
  str(v, p)
  if (Array.from(v as string).length > STRATA_LINE_MAX) fail(p, `≤ ${STRATA_LINE_MAX} code points`, v)
}

/** Required keys, plus optional ones (`key?`), and nothing else. */
const object = (shape: Record<string, Check>): Check => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'object', v)
  const record = v as Record<string, unknown>
  const allowed = new Set(Object.keys(shape).map((k) => k.replace(/\?$/, '')))
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${p}.${key}`, 'no such key in the contract', record[key])
  for (const [raw, check] of Object.entries(shape)) {
    const optional = raw.endsWith('?')
    const key = raw.replace(/\?$/, '')
    if (!(key in record)) {
      if (!optional) fail(`${p}.${key}`, 'present', undefined)
      continue
    }
    check(record[key], `${p}.${key}`)
  }
}

const machineKind = oneOf('laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox', 'unknown')

export const checkProfile = object({
  kind: machineKind,
  model: nullable(str),
  label: nullable(str),
  vendor: nullable(str),
  os: oneOf('darwin', 'linux', 'win32', 'other'),
  osVersion: nullable(str),
  arch: str,
  cpus: nullable(num),
  memoryGb: nullable(num),
  evidence: array(str)
})

const attachment = object({
  id: str,
  kind: oneOf('note', 'browser'),
  title: str,
  'host?': nullable(str),
  'tabs?': num,
  shared: bool,
  'owner?': bool
})

const agent = object({
  id: str,
  name: str,
  harness: oneOf('claude', 'codex', 'opencode', 'pi', 'shell', 'other'),
  model: nullable(str),
  orch: bool,
  phase: oneOf('idle', 'thinking', 'waiting', 'replied', 'offline'),
  phaseSource: oneOf('live', 'probe', 'ledger'),
  phaseSince: nullable(num),
  task: nullable(textLine),
  reply: nullable(textLine),
  'status?': nullable(textLine),
  turns: num,
  attachments: array(attachment)
})

const workspace = object({
  id: str,
  name: str,
  icon: nullable(str),
  'traits?': array(str),
  state: oneOf('focused', 'background'),
  agents: array(agent),
  loose: array(attachment),
  counts: object({ agents: num, notes: num, browsers: num })
})

const snapshot = object({
  v: oneOf(1),
  rev: num,
  at: num,
  machine: object({ name: str, appVersion: nullable(str), profile: checkProfile }),
  focusedWorkspaceId: nullable(str),
  workspaces: array(workspace)
})

/** The card's TerminalNodeData: the members a terminal node always has, and its kind. */
const terminalNode: Check = (v, p) => {
  if (typeof v !== 'object' || v === null) return fail(p, 'object', v)
  const n = v as Record<string, unknown>
  oneOf('terminal')(n.kind, `${p}.kind`)
  for (const key of ['id', 'name', 'preset', 'command', 'cwd']) str(n[key], `${p}.${key}`)
  bool(n.orch, `${p}.orch`)
  nullable(str)(n.role, `${p}.role`)
  object({ x: num, y: num })(n.position, `${p}.position`)
  object({ width: num, height: num })(n.size, `${p}.size`)
}

const detail = object({
  agent,
  workspaceId: str,
  'node?': terminalNode,
  notes: array(object({ id: str, title: str, content: str, shared: bool })),
  browsers: array(
    object({ id: str, title: str, url: nullable(str), tabs: array(object({ id: str, url: str })), live: bool, shared: bool })
  )
})

const EVENTS: Record<string, Check> = {
  snapshot: object({ type: str, snapshot }),
  agent: object({ type: str, rev: num, workspaceId: str, agent }),
  workspace: object({ type: str, rev: num, workspace }),
  'workspace-gone': object({ type: str, rev: num, workspaceId: str }),
  focus: object({ type: str, rev: num, workspaceId: nullable(str) })
}

const run = (check: Check, value: unknown, name: string): void => {
  expect(() => check(value, name)).not.toThrow()
}

export const assertSnapshot = (value: unknown): void => run(snapshot, value, 'snapshot')
export const assertAgentDetail = (value: unknown): void => run(detail, value, 'detail')
export const assertProfile = (value: unknown): void => run(checkProfile, value, 'profile')
export const assertEvent = (value: unknown): void => {
  const type = (value as { type?: string }).type ?? ''
  expect(Object.keys(EVENTS)).toContain(type)
  run(EVENTS[type], value, `event:${type}`)
}
