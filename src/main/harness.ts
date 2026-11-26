// Harness registry (agent-recover feature): the per-harness knowledge needed
// to RESUME an agent's existing session on (re)spawn — the same session, as
// it was, no summary/reset. One spec per harness; adding a new agent harness
// is one entry here, so recover/resume extends automatically (note
// agent-recover-feature-design).

import type { HarnessTuning } from '../shared/agent-tuning'
import { stripSessionFlags } from '../shared/claude-fork'
import { HARNESS_IDS, type HarnessId } from '../shared/harness-catalog'
import type { TerminalNodeData } from '../shared/model'
import { parseSessionTurns } from '../shared/session-turns'
import {
  createClaudeTraceAccumulator,
  createPiTraceAccumulator,
  parseCodexTurns,
  parsePiTurns,
  type TraceBlockAccumulator
} from '../shared/trace-blocks'
import type { TurnRecord } from '../shared/turn'
import { claudeWatchFile } from './claude-fork'
import { claudeTuning } from './claude-tuning'
import { codexWatchFile, resolveCodexRolloutByPid, sessionIdFromRolloutPath } from './codex-bind'
import { codexTraceAccumulatorFor, codexTurnParserFor } from './codex-lineage'
import { codexTuning } from './codex-tuning'
import { resolveOpencodeSessionByPid } from './opencode-bind'
import { piTuning } from './pi-tuning'
import {
  isPiCommand,
  piNodeSessionDir,
  piResumeCommand,
  piSessionHome,
  piWatchFile,
  stripPiSessionFlags,
  validPiSessionId
} from './pi-bind'

/** Session-root overrides a watchFile resolver honors (tests). */
export interface HarnessWatchOptions {
  projectsDir?: string
  codexSessionsDir?: string
  piSessionsRoot?: string
  piAgentDir?: string
}

export type { HarnessId }

/** TerminalNodeData fields that hold a harness's session reference. */
export type SessionField =
  | 'claudeSessionId'
  | 'codexSessionRef'
  | 'opencodeSessionId'
  | 'piSessionId'

/**
 * The node fields a watchFile resolver may read — id, cwd, and this harness's
 * own session ref. Narrower than TerminalNodeData on purpose: the per-card
 * model/effort readout is built from the durable agent registry, which holds
 * exactly these and is NOT a canvas node. Widening it back would make a live
 * card the only thing whose session file can be located, and the roster spans
 * workspaces that are not open.
 */
export type WatchSubject = Pick<TerminalNodeData, 'id' | 'cwd'> &
  Partial<Pick<TerminalNodeData, SessionField>>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * How a harness's session FILE proves that a turn ENDED (Sol round-2 P0 —
 * dispatch closure must know whether a file observer can ever close it):
 *
 * 'native'   — the parser marks the TAIL record `final: true` from a positive
 *              end-of-turn marker the harness itself writes (claude:
 *              assistant `stop_reason: 'end_turn'`; codex: the per-turn
 *              `task_complete` event, present in both rollout generations;
 *              pi: assistant `stopReason: 'stop'` — each verified against
 *              real session files). A background dispatch's turn — always
 *              the tail — closes from the file alone.
 *
 * 'boundary' — only a LATER user prompt (the next-user boundary) finalizes a
 *              record, so the tail can never prove completion and a
 *              file-backed background dispatch would strand until sweep.
 *              Dispatch acceptance must refuse file-backed background
 *              dispatch for such a harness (the conductor reads this off the
 *              watchSpec). Scrape-only harnesses declare 'boundary' too:
 *              with no file there is no tail to prove anything.
 */
export type TurnFinality = 'native' | 'boundary'

/**
 * Golden-save cloning contract (Sol r3 P1; S7, see
 * scratchpad/v5-instance-economy.html): how a harness turns a published
 * golden session file into a FRESH runnable instance. A generic byte copy is
 * NOT a clone — session formats carry identity and lineage (Claude sessionId
 * fields, Codex session_meta + rollout paths, Pi id/parent graphs), and a
 * copy that keeps them can share identity with the golden source, resume the
 * ORIGINAL conversation, break parent links, or leave the golden file open
 * to mutation. Only Claude has format-aware restamping today (claude-fork's
 * saveRoleSessionCopy/resumeRoleSession, which refuse non-Claude).
 *
 * An implementation MUST guarantee, per clone:
 *  - FRESH IDENTITY: a newly minted session id/ref, never the golden one;
 *  - REWRITTEN REFERENCES: every format-specific self-reference (embedded
 *    session ids, file paths, parent/graph links) restamped to the fresh
 *    identity — nothing in the clone names the source;
 *  - ISOLATED INSTANCE PATH: the clone lands in the instance's own session
 *    tree, never beside (or over) the golden file;
 *  - RESUME PROVENANCE VALIDATION: the resume key the clone yields is
 *    verified to resolve to the CLONE's file before it is handed to a
 *    launch command — a clone that would resume the source is a failure;
 *  - SOURCE IMMUTABILITY: the golden file is opened read-only and is
 *    byte-identical after the clone, verified, not assumed.
 *
 * No harness implements this yet — the field exists so the contract is
 * pinned in the type BEFORE S7 lands, and so absence is checkable: a harness
 * without goldenClone cannot publish golden-save templates (template
 * publishing must REFUSE, exactly like turnFinality 'boundary' refuses
 * file-backed background dispatch). tests/harness-conformance.test.ts pins
 * the absent-means-unsupported semantics.
 */
export interface GoldenCloneCapability {
  /**
   * Clone `goldenFile` into `instanceSessionDir`, returning the fresh
   * session reference (in the harness's own sessionField format) that
   * resumes the CLONE. Must throw rather than fall back to a byte copy.
   */
  clone(goldenFile: string, instanceSessionDir: string): Promise<{ sessionRef: string }>
}

/**
 * How a terminal is bound to its session — deterministically, never by an
 * mtime guess (contract rule 3). spawnTracked dispatches on this, not on the
 * harness's name, so a new harness that picks an existing strategy gets
 * binding AND resume with no new call site (contract rule 4).
 *
 * 'minted'        — Cookrew names the session id before boot (claude
 *                   --session-id), then follows what the process reports.
 * 'pid-held'      — the session file the pane's process holds open (lsof of
 *                   the pane pid), polled after boot until it appears;
 *                   resume = resumeCommand(resumeKey(stored ref)).
 * 'exclusive-dir' — every terminal gets its own session directory (pi
 *                   --session-dir); the session inside it is the card's.
 */
export type BindStrategy =
  | { kind: 'minted' }
  | { kind: 'pid-held'; resolveByPid: (pid: number | null) => string | null }
  | { kind: 'exclusive-dir' }

export interface Harness {
  id: HarnessId
  /** How a terminal is bound to its session (see BindStrategy). */
  bind: BindStrategy
  /** True when a launch command runs this harness. */
  matches(command: string): boolean
  /** The node field holding this harness's session reference. */
  sessionField: SessionField
  /** Resume KEY (session id) from the stored field value, or null if unusable. */
  resumeKey(sessionRef: string): string | null
  /** Launch command that RESUMES the given session key, full session as-is.
   *  `context` is REQUIRED (M6): harnesses that scope sessions by terminal
   *  (pi — exclusive --session-dir) cannot build an honest resume without it,
   *  so an optional param was a latent runtime throw on the first generic pi
   *  call site. `cwd` is part of it because a session may live outside the
   *  terminal's own directory (pi legacy-pane adoption, contract rule 8) and
   *  resuming it in the wrong directory strands the conversation. Harnesses
   *  that don't need either field simply ignore them. */
  resumeCommand(command: string, key: string, context: { terminalId: string; cwd: string }): string
  /**
   * The launch command with every session-binding flag removed. A copy (fork,
   * team duplicate, published template) must never carry the source's
   * binding: it would resume — and append to — the SOURCE's session file.
   * Bindings live on node fields; the spawn rebuilds the flags.
   */
  stripSessionFlags(command: string): string
  /**
   * Turn-history capability (harness-integration-contract):
   * 'file'   — durable TurnRecords are derived from the harness's session
   *            FILE (SessionTurnSync reconcile); `parseTurns` must be wired
   *            and its indices must equal the trace-block indices.
   * 'scrape' — PTY-scrape only; a conscious, declared limitation. New
   *            harnesses are expected to reach 'file' before their preset
   *            ships (tests/harness-conformance.test.ts pins this).
   */
  turns: 'file' | 'scrape'
  /**
   * Whether this harness's parser can prove END-OF-TURN on the tail record
   * (see TurnFinality). Required so a new harness DECLARES its closure story
   * rather than inheriting a strand-until-sweep default.
   */
  turnFinality: TurnFinality
  /** Session-file lines → TurnRecords; present exactly when turns === 'file'. */
  parseTurns?: (lines: string[]) => TurnRecord[]
  /**
   * The turn parser for ONE session file, when that file's history does not
   * start in the file itself (a Codex continuation rollout carries on from a
   * prefix of an earlier one — codex-lineage.ts). Absent means `parseTurns`.
   * Must return the same object for the same file: SessionTurnSync re-watches
   * by parser identity.
   */
  parseTurnsFor?: (
    file: string,
    options: HarnessWatchOptions
  ) => (lines: string[]) => TurnRecord[]
  /**
   * The session file SessionTurnSync should poll for this node, or null when
   * unbound/unusable. Owned by the harness so adding one is registry-only
   * (contract rule 4) — each resolver carries its own security validation
   * (UUID shape, sessions-tree prefix, exclusive-dir scan). Present exactly
   * when turns === 'file'.
   */
  watchFile?: (node: WatchSubject, options: HarnessWatchOptions) => string | null
  /**
   * A fresh, resumable trace-block parser for ONE session file: the trace
   * drawer, checkpoint rail, index and CHAT/LOG stream all read the file
   * `watchFile` names through it. Present exactly when turns === 'file' —
   * the same lines feed `parseTurns`, so the two can never disagree about
   * which file is this card's (contract rule 4: no per-harness branch in
   * trace.ts or stream-service.ts).
   */
  traceParser?: (file: string, options: HarnessWatchOptions) => TraceBlockAccumulator
  /**
   * THE DIALS (shared/agent-tuning): which model answers and how hard it
   * thinks, when this harness can both set them from one typed line AND write
   * them back onto its own replies. Absent means the zoomed card's rail
   * explains where they are set instead of offering buttons.
   *
   * Declaring `tuning` REQUIRES turns === 'file': confirmation reads the
   * session record, so a scrape-only harness could offer a dial and never be
   * able to say whether turning it worked — precisely the state decision 3 of
   * agent-tuning exists to prevent. Pinned by tests/harness-conformance.
   */
  tuning?: HarnessTuning
  /**
   * Golden-save clone capability (see GoldenCloneCapability). ABSENT on
   * every harness today — absent means golden-save template publishing must
   * refuse this harness; it must never degrade to a byte copy.
   */
  goldenClone?: GoldenCloneCapability
}

const CLAUDE: Harness = {
  id: 'claude',
  matches: (c) => /^\s*claude\b/.test(c),
  bind: { kind: 'minted' },
  sessionField: 'claudeSessionId',
  resumeKey: (ref) => (ref ? ref : null),
  resumeCommand: (command, key) => `${stripSessionFlags(command)} --resume ${key}`,
  stripSessionFlags,
  turns: 'file',
  // Tail proof: assistant stop_reason 'end_turn' (session-turns accumulator).
  turnFinality: 'native',
  parseTurns: parseSessionTurns,
  watchFile: claudeWatchFile,
  traceParser: () => createClaudeTraceAccumulator(),
  tuning: claudeTuning
}

/** Codex's `resume` subcommand and everything after it (global opts stay before it). */
const stripCodexResume = (command: string): string => command.replace(/\s+resume\b.*$/, '').trim()

const CODEX: Harness = {
  id: 'codex',
  matches: (c) => /^\s*codex\b/.test(c),
  // The rollout the codex process holds open is its session.
  bind: { kind: 'pid-held', resolveByPid: (pid) => resolveCodexRolloutByPid(pid) },
  // Stored ref is the rollout FILE path; the resume key is its session uuid.
  sessionField: 'codexSessionRef',
  resumeKey: (ref) => sessionIdFromRolloutPath(ref) ?? (UUID_RE.test(ref) ? ref : null),
  // Global opts (e.g. --dangerously-bypass-approvals-and-sandbox) MUST stay
  // BEFORE the `resume` subcommand (Tinker). Strip any prior resume tail.
  resumeCommand: (command, key) =>
    `${stripCodexResume(command)} resume ${key}`,
  stripSessionFlags: (command) => stripCodexResume(stripSessionFlags(command)),
  turns: 'file',
  // Tail proof: the rollout's own per-turn `task_complete` event (verified on
  // real ~/.codex/sessions files, both rollout generations; an interrupted
  // turn writes `turn_aborted` instead and stays non-final — correct).
  turnFinality: 'native',
  parseTurns: parseCodexTurns,
  // A backtrack continues the conversation in a new rollout that holds only
  // what came after the cut; the ledger must still see what came before it.
  parseTurnsFor: (file, options) =>
    codexTurnParserFor(file, { sessionsDir: options.codexSessionsDir }),
  watchFile: codexWatchFile,
  // A continuation rollout numbers its blocks on from the base it carries.
  traceParser: (file, options) => codexTraceAccumulatorFor(file, { sessionsDir: options.codexSessionsDir }),
  // READ ONLY: codex stamps every turn with its model and effort, but changes
  // them only in its own picker — see codex-tuning.
  tuning: codexTuning
}

const OPENCODE_SESSION_FLAG_RE = /\s(?:--session|--continue|-s|-c)(?:[= ]\S+)?/g
const OPENCODE: Harness = {
  id: 'opencode',
  matches: (c) => /^\s*opencode\b/.test(c),
  bind: { kind: 'pid-held', resolveByPid: (pid) => resolveOpencodeSessionByPid(pid) },
  sessionField: 'opencodeSessionId',
  // Defense-in-depth (HIGH-2): opencodeSessionId can arrive via the unauth
  // node-patch endpoint and flows into a shell command — validate the
  // `ses_<base62>` shape before it can reach the launch string.
  resumeKey: (ref) => (/^ses_[A-Za-z0-9]+$/.test(ref) ? ref : null),
  resumeCommand: (command, key) =>
    `${command.replace(OPENCODE_SESSION_FLAG_RE, '').trim()} --session ${key}`,
  stripSessionFlags: (command) => stripSessionFlags(command).replace(OPENCODE_SESSION_FLAG_RE, '').trim(),
  // OpenCode has no session-file trace/turn parser yet — declared limitation.
  turns: 'scrape',
  // No file, no tail, no proof: a file-backed dispatch can never close here.
  turnFinality: 'boundary'
}

const PI: Harness = {
  id: 'pi',
  matches: isPiCommand,
  bind: { kind: 'exclusive-dir' },
  sessionField: 'piSessionId',
  stripSessionFlags: stripPiSessionFlags,
  // This value can be restored from persisted/mobile-originated node data and
  // reaches a shell command, so accept only Pi's closed session-id alphabet.
  resumeKey: (ref) => (validPiSessionId(ref) ? ref : null),
  // Resume in the directory that HOLDS the session: the terminal's exclusive
  // dir normally, pi's own cwd dir for a session adopted from a legacy pane.
  // Hard-coding the exclusive dir would boot an empty conversation beside the
  // real one — the exact outcome the adoption path exists to prevent.
  resumeCommand: (command, key, context) =>
    piResumeCommand(
      command,
      key,
      piSessionHome(context.cwd, key, context.terminalId)?.dir ??
        piNodeSessionDir(context.terminalId)
    ),
  turns: 'file',
  // Tail proof: pi's assistant `stopReason: 'stop'` (verified on real
  // ~/.cookrew/pi-sessions files; 'toolUse' is mid-turn, 'aborted'/'error'/
  // 'length' are not completion and stay non-final).
  turnFinality: 'native',
  parseTurns: parsePiTurns,
  watchFile: piWatchFile,
  traceParser: () => createPiTraceAccumulator(),
  // READ ONLY, and model only: pi stamps each assistant message with its
  // model and records no effort — see pi-tuning.
  tuning: piTuning
}

/** One entry per catalog id: a new id does not compile until it has one. */
export const HARNESS_BY_ID: Readonly<Record<HarnessId, Harness>> = {
  claude: CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
  pi: PI
}

/** Every registered harness, in catalog order. Conformance: tests/harness-conformance.test.ts. */
export const HARNESSES: Harness[] = HARNESS_IDS.map((id) => HARNESS_BY_ID[id])

/**
 * The launch command with its session-binding flags removed, per harness. A
 * plain shell gets Claude's strip, as it always did (a shell line names no
 * harness, and the strip is a no-op on it).
 */
export function withoutSessionFlags(command: string): string {
  return (harnessFor(command) ?? CLAUDE).stripSessionFlags(command)
}

/** The harness a launch command runs, or null (plain shell / unknown). */
export function harnessFor(command: string): Harness | null {
  return HARNESSES.find((h) => h.matches(command)) ?? null
}
