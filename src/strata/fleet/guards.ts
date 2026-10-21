// What crosses the wire into the fleet store is checked at the door: the
// registry list, a desktop's snapshot and every stream event. A row or event
// that fails is dropped (a list) or treated as a resync (a stream) — never
// half-applied.
import { STRATA_VERSION, type FleetMachine, type LevelsEvent, type LevelsSnapshot } from '../../shared/strata'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isString = (value: unknown): value is string => typeof value === 'string'
const isNumberOrNull = (value: unknown): value is number | null => value === null || typeof value === 'number'
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

/**
 * A base is same-origin and path-only: '/relay/@user/desktop/<id>/' in
 * production, '/m/<id>/' in the preview. Anything absolute or protocol-relative
 * would send the pairing token to another origin, so it is refused here.
 */
export const isSafeBase = (base: unknown): base is string =>
  isString(base) && base.startsWith('/') && !base.startsWith('//') && base.endsWith('/') && !/[?#\\]/.test(base)

export const isFleetMachine = (value: unknown): value is FleetMachine =>
  isObject(value) &&
  isString(value.id) &&
  value.id.length > 0 &&
  isString(value.name) &&
  typeof value.online === 'boolean' &&
  isNumberOrNull(value.lastSeenAt) &&
  isStringOrNull(value.appVersion) &&
  (value.profile === null || isObject(value.profile)) &&
  isSafeBase(value.base)

/** The registry list, keeping the rows that pass and the order it gave. */
export const parseFleetList = (body: unknown): FleetMachine[] => {
  const rows = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.desktops) ? body.desktops : []
  const seen = new Set<string>()
  return rows.filter((row): row is FleetMachine => {
    if (!isFleetMachine(row) || seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

export const isLevelsSnapshot = (value: unknown): value is LevelsSnapshot =>
  isObject(value) &&
  value.v === STRATA_VERSION &&
  typeof value.rev === 'number' &&
  typeof value.at === 'number' &&
  isObject(value.machine) &&
  isStringOrNull(value.focusedWorkspaceId) &&
  Array.isArray(value.workspaces) &&
  value.workspaces.every((w) => isObject(w) && isString(w.id) && Array.isArray(w.agents))

const DELTA_TYPES = new Set(['agent', 'agent-gone', 'workspace', 'workspace-gone', 'focus'])

/** One SSE `data:` payload, or null when it is not a levels event this version understands. */
export const parseLevelsEvent = (data: string): LevelsEvent | null => {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (!isObject(value) || !isString(value.type)) return null
  if (value.type === 'snapshot') return isLevelsSnapshot(value.snapshot) ? (value as unknown as LevelsEvent) : null
  if (!DELTA_TYPES.has(value.type) || typeof value.rev !== 'number') return null
  if (value.type === 'agent' && !(isString(value.workspaceId) && isObject(value.agent) && isString(value.agent.id))) return null
  if (value.type === 'workspace' && !(isObject(value.workspace) && isString(value.workspace.id) && Array.isArray(value.workspace.agents)))
    return null
  return value as unknown as LevelsEvent
}
