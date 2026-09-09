// WHICH FILES ARE THE STREAM (one-stream T1, docs/site/one-stream-2026-09-07.html).
//
// The design is explicit that this part is KEPT, not replaced: "the oracle,
// the lineage spill, the gate — unchanged. They decide WHICH files are the
// stream; this design decides what is read from them." So this module is a
// thin, honest ordering over what already exists:
//
//   binding ∪ node lineage ∪ spill, oldest first
//
// exactly the union trace.ts's lineageSegments already takes — the declared
// rotation walk (session-lineage-walk.sessionChain, a FACT read out of each
// transcript's head) in front of it the ids this app recorded that no
// transcript declares any more. That second set is not decoration: it is what
// survived the 2026-09-06 cap incident, where a /clear broke an edge and a
// 20-entry slice took the head off a chain. Node lineage ∪ spill is where
// those ids live now (lineage-spill.ts).
//
// A recorded id whose transcript is NOT on disk is REPORTED, never dropped
// and never thrown: an id with no file is honestly absent, and the caller
// gets to say so out loud instead of showing a silently shorter history.

import { existsSync } from 'node:fs'
import { isClaudeCommand } from '../shared/claude-fork'
import { claudeSessionFile } from './claude-fork'
import { sessionChain } from './session-lineage-walk'
import { reachableLineage, type LineageBearingNode } from './lineage-spill'
import type { TraceKind } from './trace'

/** One transcript in the chain, in stream order. */
export interface StreamFile {
  sessionId: string
  file: string
  kind: TraceKind
  /**
   * The rotation walk DECLARED this file — some transcript's head names it,
   * so its place in the chain is a fact read off disk.
   *
   * Absent means the opposite: a recorded id no transcript declares any more,
   * placed here by judgement rather than evidence. stream.ts uses the flag to
   * put those back in time by their own blocks' clock instead of leaving them
   * at the front (see placeUndeclared there, and the incident in its
   * docblock). Nothing else reads it, and the ORDER this function returns is
   * unchanged.
   */
  declared?: true
}

/** A member of the chain that could not be read. Reported, never thrown. */
export interface MissingStreamFile {
  sessionId: string
  file: string
  reason: 'no-transcript' | 'unreadable'
}

export interface StreamChain {
  files: StreamFile[]
  missing: MissingStreamFile[]
}

/** What chain resolution needs off a node — nothing more, so a script can
 *  hand over a workspace JSON record without constructing a store. */
export interface ChainNode extends LineageBearingNode {
  id: string
  cwd: string
  command: string
}

export interface ChainOptions {
  projectsDir?: string
  /**
   * Every session id this card can still reach, oldest first. Defaults to
   * `reachableLineage` — the app's own rule, which also MIGRATES a node's
   * array into the durable spill on first read. A caller that must not write
   * (the equivalence harness runs against the owner's real ~/.cookrew)
   * passes a read-only variant instead.
   */
  lineageIds?: (node: ChainNode) => readonly string[]
}

/**
 * The Claude lineage of one card as one ordered stream, oldest first.
 *
 * ORDERING, stated plainly because it is a judgement call: the declared walk
 * is authoritative and keeps its own order; recorded ids the walk does not
 * declare go IN FRONT of it. They cannot be placed by evidence — that is what
 * "undeclared" means — and the walk stops exactly where an edge is missing,
 * so an undeclared id is nearly always an ancestor of the walk's root. This
 * is the same order the rail's lineage expansion has used all along
 * (trace.ts, recordedSegments ++ chain); the stream inherits it rather than
 * inventing a second one.
 *
 * Non-Claude harnesses have no lineage to walk — one rollout, one stream —
 * and are supplied by the caller (T2 wires the reader's other sources).
 */
export async function claudeStreamChain(
  node: ChainNode,
  options: ChainOptions = {}
): Promise<StreamChain> {
  if (!isClaudeCommand(node.command) || !node.claudeSessionId) {
    return { files: [], missing: [] }
  }
  const walked = await declaredChain(node, options)
  const walkedIds = new Set(walked.map((step) => step.sessionId))
  const recorded = readLineage(node, options)
    .filter((sessionId) => !walkedIds.has(sessionId))
    .map((sessionId) => ({
      sessionId,
      file: claudeSessionFile(node.cwd, sessionId, options.projectsDir)
    }))

  const files: StreamFile[] = []
  const missing: MissingStreamFile[] = []
  const declaredFiles = new Set(walked.map((step) => step.file))
  for (const step of [...recorded, ...walked]) {
    if (existsSync(step.file)) {
      files.push({
        sessionId: step.sessionId,
        file: step.file,
        kind: 'claude',
        ...(declaredFiles.has(step.file) ? { declared: true as const } : {})
      })
    } else {
      missing.push({ sessionId: step.sessionId, file: step.file, reason: 'no-transcript' })
    }
  }
  return { files, missing }
}

/** The rotation walk, never fatal: a failed walk costs the declared edges,
 *  not the whole chain — the recorded ids still stand the history up. */
async function declaredChain(
  node: ChainNode,
  options: ChainOptions
): Promise<{ sessionId: string; file: string }[]> {
  try {
    return await sessionChain(node.cwd, node.claudeSessionId as string, {
      projectsDir: options.projectsDir
    })
  } catch (error) {
    console.error('stream chain: rotation walk failed:', error)
    return []
  }
}

function readLineage(node: ChainNode, options: ChainOptions): readonly string[] {
  const read = options.lineageIds ?? ((n: ChainNode) => reachableLineage(n.id, n))
  try {
    return read(node)
  } catch (error) {
    console.error('stream chain: lineage read failed:', error)
    return node.claudeSessionId ? [node.claudeSessionId] : []
  }
}

/**
 * Node lineage ∪ current binding, oldest first, WITHOUT touching disk.
 *
 * The read-only lineage source for tools that must not write into the
 * owner's ~/.cookrew — `reachableLineage` records what it reads (that is the
 * migration that made the cap incident survivable), which is right inside the
 * app and wrong inside a harness that is only measuring.
 */
export function nodeLineageIds(node: ChainNode): string[] {
  const ids = [...(node.sessionLineage ?? [])]
  if (node.claudeSessionId) ids.push(node.claudeSessionId)
  return ids.filter((id, at) => id.length > 0 && ids.indexOf(id) === at)
}
