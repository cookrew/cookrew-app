/**
 * What a listener can reach, walked rather than grepped.
 *
 * TRANSITIVE ON PURPOSE. A one-hop rule ("no listener source imports the grant
 * module") is defeated by a helper in between, and a helper in between is the
 * LIKELIER accident — nobody adds `import { OwnerGrant }` to mobile-api.ts on a
 * whim, but plenty of people add a small bridge module that ends up importing
 * it two hops away. So the walk follows every static value edge to a fixpoint
 * and reports the whole chain, because a violation you cannot see the shape of
 * is a violation people argue with rather than fix.
 */

import path from 'node:path'
import {
  parseImportEdges,
  resolveSpecifier,
  sourceFiles,
  stripComments,
  type SourcePort
} from './module-imports'

export type ViolationKind =
  | 'grant-reach'
  | 'unresolvable-import'
  | 'ipc-primitive'
  | 'electron-surface'

export interface Violation {
  kind: ViolationKind
  /** The file the violation is IN. */
  file: string
  line: number
  /** Root → … → file, so the accidental middle hop is visible. */
  chain: readonly string[]
  detail: string
}

export interface ReachResult {
  /** Every file reachable from a root, mapped to its shortest chain. */
  reached: ReadonlyMap<string, readonly string[]>
  /** Dynamic edges whose destination is not statically knowable. */
  unresolvable: readonly { file: string; line: number; chain: readonly string[] }[]
}

/**
 * Every file reachable from the roots by a static VALUE import.
 *
 * Breadth-first, so the chain reported for a file is its shortest one — the
 * most legible explanation of why it is reachable at all.
 */
export function reachFrom(roots: readonly string[], port: SourcePort): ReachResult {
  const reached = new Map<string, readonly string[]>()
  const unresolvable: { file: string; line: number; chain: readonly string[] }[] = []
  const queue: string[] = []

  for (const root of roots) {
    for (const file of sourceFiles(root, port)) {
      if (reached.has(file)) continue
      reached.set(file, [file])
      queue.push(file)
    }
  }

  while (queue.length > 0) {
    const file = queue.shift() as string
    const chain = reached.get(file) as readonly string[]
    const source = port.read(file)
    if (source === null) continue
    for (const edge of parseImportEdges(source)) {
      if (edge.typeOnly) continue
      if (edge.computed) {
        unresolvable.push({ file, line: edge.line, chain })
        continue
      }
      if (edge.specifier === null) continue
      const target = resolveSpecifier(file, edge.specifier, port)
      if (target === null || reached.has(target)) continue
      reached.set(target, [...chain, target])
      queue.push(target)
    }
  }

  return { reached, unresolvable }
}

export interface GrantSweepOptions {
  /** Modules that answer requests from outside this process. */
  roots: readonly string[]
  /** Modules holding operations that decide who reaches the internet. */
  forbidden: readonly string[]
  /**
   * The electron bindings a listener-reachable module may import.
   *
   * CLOSED, and that is the whole point. The name list this replaced had to
   * enumerate what was FORBIDDEN, so anything newly named — `ipcMain` under an
   * alias, a fresh IPC primitive — passed by not being on it. Here a binding
   * nobody has vouched for fails by default, which is the same closed-default
   * rule the grant record itself is built on.
   */
  electronAllowed: readonly string[]
  /** For messages only. */
  relativeTo?: string
}

/**
 * The IPC primitives, refused as PRIMITIVES rather than by channel name.
 *
 * The channel half of this sweep used to list `grant:enrol`, `grant:revoke`…
 * and look for those literals. Magpie proved that blind too, one layer along
 * from the alias hole: a bridge that builds the channel as `grant:${op}` never
 * spells any of them, so the literal search passes while the bridge mounts all
 * four. A computed name defeats a name search by construction. What it cannot
 * do is avoid touching the primitive, so the primitive is what is refused.
 */
const IPC_PRIMITIVES = ['ipcMain', 'ipcRenderer']

export function sweepGrantReach(options: GrantSweepOptions, port: SourcePort): Violation[] {
  const root = options.relativeTo
  const show = (file: string): string => (root ? path.relative(root, file) : file)
  const { reached, unresolvable } = reachFrom(options.roots, port)
  const forbidden = new Set(options.forbidden)
  const violations: Violation[] = []

  for (const [file, chain] of reached) {
    if (!forbidden.has(file)) continue
    violations.push({
      kind: 'grant-reach',
      file: show(file),
      line: 0,
      chain: chain.map(show),
      detail: `a listener reaches the grant surface: ${chain.map(show).join(' → ')}`
    })
  }

  for (const edge of unresolvable) {
    violations.push({
      kind: 'unresolvable-import',
      file: show(edge.file),
      line: edge.line,
      chain: edge.chain.map(show),
      detail:
        'dynamic import with a computed specifier — where it goes is not ' +
        'statically knowable, so this is BLOCKED rather than passed over'
    })
  }

  for (const [file, chain] of reached) {
    const source = port.read(file)
    if (source === null) continue
    const code = stripComments(source)

    code.split('\n').forEach((text, index) => {
      for (const primitive of IPC_PRIMITIVES) {
        if (!new RegExp(`\\b${primitive}\\b`).test(text)) continue
        violations.push({
          kind: 'ipc-primitive',
          file: show(file),
          line: index + 1,
          chain: chain.map(show),
          detail: `listener-reachable code touches ${primitive}: ${text.trim()}`
        })
      }
    })

    for (const edge of parseImportEdges(code)) {
      if (edge.specifier !== 'electron' || edge.typeOnly) continue
      if (edge.namespace) {
        violations.push({
          kind: 'electron-surface',
          file: show(file),
          line: edge.line,
          chain: chain.map(show),
          detail: 'namespace import of electron carries every primitive, including the IPC ones'
        })
        continue
      }
      for (const binding of edge.bindings) {
        if (options.electronAllowed.includes(binding)) continue
        violations.push({
          kind: 'electron-surface',
          file: show(file),
          line: edge.line,
          chain: chain.map(show),
          detail: `electron binding '${binding}' is not on the listener allow-list`
        })
      }
    }
  }

  return violations
}
