// STRATA URLS: /me · /me/<machine> · /me/<machine>/<workspace> ·
// /me/<machine>/<workspace>/<agent>. StrataPath keeps ids; slugs live here and
// in the address bar only. An unknown slug resolves to the nearest level that
// exists, except while that level is still loading, when it waits.
import type { MachineLink, StrataPath } from '../../shared/strata'
import { matchSibling, siblingSlugs, type Named } from './slug'

/** The slice of a StrataMachine the URL needs (structural, so tests need no full rows). */
export interface UrlMachine extends Named {
  link: MachineLink
  levels: { workspaces: ReadonlyArray<Named & { agents: readonly Named[] }> } | null
}

/** /me/account is the account page (D2): no machine may take that slug. */
export const RESERVED_MACHINE_SLUGS: ReadonlySet<string> = new Set(['account'])

export type ParsedUrl = { kind: 'levels'; slugs: string[] } | { kind: 'reserved'; name: string } | { kind: 'other' }

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export const parseStrataUrl = (pathname: string): ParsedUrl => {
  const match = /^\/me(?:\/(.*))?$/.exec(pathname)
  if (!match) return { kind: 'other' }
  const slugs = (match[1] ?? '').split('/').filter(Boolean).map(decode)
  if (slugs.length === 1 && RESERVED_MACHINE_SLUGS.has(slugs[0])) return { kind: 'reserved', name: slugs[0] }
  return { kind: 'levels', slugs: slugs.slice(0, 3) }
}

const segment = (slug: string) => encodeURIComponent(slug)

/** The URL of a path; stops at the deepest part it can name. */
export const formatStrataUrl = (path: StrataPath, fleet: readonly UrlMachine[]): string => {
  const parts: string[] = []
  const machine = fleet.find((m) => m.id === path.machine)
  if (machine) {
    parts.push(siblingSlugs(fleet, RESERVED_MACHINE_SLUGS).get(machine.id) as string)
    const workspaces = machine.levels?.workspaces ?? []
    const workspace = path.workspace ? workspaces.find((w) => w.id === path.workspace) : undefined
    if (workspace) {
      parts.push(siblingSlugs(workspaces).get(workspace.id) as string)
      const agent = path.agent ? workspace.agents.find((a) => a.id === path.agent) : undefined
      if (agent) parts.push(siblingSlugs(workspace.agents).get(agent.id) as string)
    }
  }
  return ['/me', ...parts.map(segment)].join('/')
}

export interface Resolution {
  path: StrataPath
  /** The URL is already the canonical one for `path`. */
  exact: boolean
  /** The first level whose slug named nothing; the view falls back above it. */
  missing: 'machine' | 'workspace' | 'agent' | null
  missingSlug?: string
  /** That level is still loading: keep the URL and resolve again on the next snapshot. */
  pending: boolean
}

/** A machine whose levels may still arrive: wait for it before falling back. */
const mayStillLoad = (link: MachineLink) => link === 'connecting'

export const resolveStrataUrl = (slugs: readonly string[], fleet: readonly UrlMachine[], opts: { loaded: boolean }): Resolution => {
  const done = (path: StrataPath, missing: Resolution['missing'] = null, missingSlug?: string, pending = false): Resolution => {
    const canonical = formatStrataUrl(path, fleet)
    const asked = ['/me', ...slugs.slice(0, Object.keys(path).length).map(segment)].join('/')
    return { path, exact: missing === null && !pending && canonical === asked, missing, ...(missingSlug !== undefined && { missingSlug }), pending }
  }
  const [machineSlug, workspaceSlug, agentSlug] = slugs
  if (!machineSlug) return done({})
  if (!opts.loaded) return done({}, null, undefined, true)

  const machine = matchSibling(fleet, machineSlug, RESERVED_MACHINE_SLUGS)
  if (!machine) return done({}, 'machine', machineSlug)
  const atMachine = { machine: machine.id }
  if (!workspaceSlug) return done(atMachine)
  if (!machine.levels) return mayStillLoad(machine.link) ? done(atMachine, null, undefined, true) : done(atMachine, 'workspace', workspaceSlug)

  const workspace = matchSibling(machine.levels.workspaces, workspaceSlug)
  if (!workspace) return done(atMachine, 'workspace', workspaceSlug)
  const atWorkspace = { machine: machine.id, workspace: workspace.id }
  if (!agentSlug) return done(atWorkspace)

  const agent = matchSibling(workspace.agents, agentSlug)
  if (!agent) return done(atWorkspace, 'agent', agentSlug)
  return done({ ...atWorkspace, agent: agent.id })
}
