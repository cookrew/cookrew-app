import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sessionIdFromRolloutPath } from '../src/main/codex-bind'
import {
  codexBaseChain,
  codexRolloutContinues,
  codexRolloutToFollow,
  codexSuccessorsOf
} from '../src/main/codex-lineage'
import { createStreamService } from '../src/main/stream-service'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import type { TerminalNodeData } from '../src/shared/model'
import type { SessionTurnAccumulator, StreamingTurnParser } from '../src/shared/session-turns'

/**
 * A Codex BACKTRACK, cut from the real "Theme System" rollouts (2026-11-13),
 * scrubbed: ids replaced, long text cut, tool output dropped.
 *
 * What happened: the owner interrupted a turn ("退回上一版…", reply "Now the
 * styles:") and edited that message with Esc-Esc. Codex kept the thread id and
 * opened a NEW rollout file, `<thread>_<rollout>.jsonl`, whose session_meta
 * names the old file's prefix in `history_base` (cut just before the
 * interrupted turn). Every turn after that lives only in the new file, while
 * the card stayed bound to the old one, so CHAT stopped at "Now the styles:".
 */
const THREAD = '01a1cdcf-0000-7000-8000-00000000c0de'
const FIXTURE = path.join(__dirname, 'fixtures', 'codex-backtrack')
const OLD_REL = '2026/11/12/rollout-2026-11-12T11-31-48-01a1cdcf-0000-7000-8000-00000000c0de.jsonl'
const NEW_REL =
  '2026/11/13/rollout-2026-11-13T23-00-37-01a1cdcf-0000-7000-8000-00000000c0de_01a1d56c-0000-7000-8000-00000000beef.jsonl'
/** When the new rollout appeared. */
const MOVED_AT = Date.parse('2026-11-13T15:00:37Z')

function sessionsTree(): { dir: string; oldFile: string; newFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-backtrack-'))
  cpSync(FIXTURE, dir, { recursive: true })
  return {
    dir,
    oldFile: path.join(dir, OLD_REL),
    newFile: path.join(dir, NEW_REL)
  }
}

function codexNode(ref: string): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'theme-system',
    name: 'Theme System',
    preset: 'Codex',
    command: 'codex -m auto/gpt-6.1-sol',
    cwd: '/Users/owner/workspace/cookrew-dev',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    codexSessionRef: ref
  } as TerminalNodeData
}

function bed() {
  const tree = sessionsTree()
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'codex-backtrack-ws-')))
  const node = store.addNode(codexNode(tree.oldFile)) as TerminalNodeData
  store.updateNodeUnsafe(node.id, { codexSessionRef: tree.oldFile })
  const traces = new TraceReader(store, { codexSessionsDir: tree.dir })
  const service = createStreamService({
    nodeOf: (id) => {
      const hit = store.nodeAcrossWorkspaces(id)
      return hit && hit.node.kind === 'terminal' ? (hit.node as TerminalNodeData) : null
    },
    documentOf: (file, kind) => traces.documentOf(file, kind),
    fileOf: (n) => traces.watchSpec(n.id)?.file ?? null,
    stateOptions: {
      dir: mkdtempSync(path.join(tmpdir(), 'codex-backtrack-state-'))
    },
    markOptions: {
      dir: mkdtempSync(path.join(tmpdir(), 'codex-backtrack-marks-'))
    },
    chainCoalesceMs: 0
  })
  return { ...tree, store, node, traces, service }
}

const head = (prompt: string): string => prompt.slice(0, 12)

describe('Codex backtrack: the card follows the rollout the process moved to', () => {
  it('resumes by the THREAD id, also from a continuation file name', () => {
    const { newFile, oldFile } = sessionsTree()
    expect(sessionIdFromRolloutPath(oldFile)).toBe(THREAD)
    // `<thread>_<rollout>.jsonl`: `codex resume` takes the thread id.
    expect(sessionIdFromRolloutPath(newFile)).toBe(THREAD)
  })

  it('names the new rollout as the continuation of the bound one, and nothing else', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(true)
    expect(codexRolloutContinues(oldFile, newFile, { sessionsDir: dir })).toBe(false)
    expect(codexRolloutContinues(oldFile, oldFile, { sessionsDir: dir })).toBe(false)
    expect(codexSuccessorsOf(oldFile, { sessionsDir: dir, aroundMs: MOVED_AT })).toEqual([newFile])
    expect(codexSuccessorsOf(newFile, { sessionsDir: dir, aroundMs: MOVED_AT })).toEqual([])
  })

  it('refuses a history_base whose offset does not land on the record it names', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const lines = readFileSync(newFile, 'utf8').split('\n')
    const meta = JSON.parse(lines[0])
    meta.payload.history_base.end_byte_offset += 7
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(false)
  })

  it('CHAT reaches the latest turn once rebound, with the history before the backtrack intact', async () => {
    const { store, node, newFile, service } = bed()

    // THE BUG, reproduced: bound to the old rollout, the stream ends on the
    // interrupted turn.
    const stuck = await service.tailState(node.id)
    expect(stuck.block?.reply).toBe('Now the styles:')

    // The process moved to the continuation; the card follows it.
    store.updateNodeUnsafe(node.id, { codexSessionRef: newFile })
    const tail = await service.tailState(node.id)
    expect(head(tail.block?.prompt ?? '')).toBe(head('recruit cookrew teammate修复'))
    expect(tail.final).toBe(true)

    const page = await service.blocks(node.id, { limit: 50 })
    const prompts = page.blocks.map((block) => block.prompt)
    const expected = [
      'agents数量和artifacts数量',
      'agent card不要了，就便笺条',
      // The interrupted exchange really happened and stays where it was.
      '退回上一版，以上一版为基础的交互想法，滑动agents则把浏览器缩略图变成agent概览，滑动（按住，处理当前屏幕）',
      // The edited resend, and everything after it, from the new rollout.
      '退回上一版，以上一版为基础的交互想法，滑动agents则把浏览器缩略图变成agent概览，滑动（按住，处理当前浏览器卡）',
      '所有事情都在workspace avatar里完成',
      '不跳转其他页面',
      '大体对，细节再优化。',
      'recruit cookrew teammate修复'
    ]
    expect(prompts).toHaveLength(expected.length)
    expected.forEach((start, at) => expect(prompts[at].startsWith(start)).toBe(true))
    expect(page.blocks[2].reply).toBe('Now the styles:')
    expect(page.blocks.map((block) => block.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(page.blocks.map((block) => block.id)).size).toBe(8)
    const index = await service.materialised?.(node.id)
    expect(index?.anomalies.IdentityCollision).toBeUndefined()
  })

  it('a fresh read of the continuation carries the whole conversation', async () => {
    const { store, node, oldFile, newFile, traces } = bed()
    const before = await traces.page(node.id, { limit: 50 })
    store.updateNodeUnsafe(node.id, { codexSessionRef: newFile })
    const page = await traces.page(node.id, { limit: 50 })
    expect(page.total).toBe(7)
    // The exchanges before the cut keep the identities the old file gave them,
    // so rows, marks and titles keyed by identity carry across the move.
    expect(page.blocks.slice(0, 2).map((block) => block.id)).toEqual(
      before.blocks.slice(0, 2).map((block) => block.id)
    )
    // The resend is NOT the interrupted exchange: a different identity.
    expect(before.blocks[2].id).not.toBe(page.blocks[2].id)
    expect(oldFile).not.toBe(newFile)
  })

  it('the turn ledger reads the continuation with its history too', () => {
    const { store, node, newFile, traces } = bed()
    store.updateNodeUnsafe(node.id, { codexSessionRef: newFile })
    const spec = traces.watchSpec(node.id)
    expect(spec?.file).toBe(newFile)
    const parser = spec?.parse as StreamingTurnParser
    const accumulator: SessionTurnAccumulator = parser.createAccumulator()
    accumulator.feed(readFileSync(newFile, 'utf8').split('\n'))
    const records = accumulator.records()
    expect(records).toHaveLength(7)
    expect(head(records[0].prompt)).toBe(head('agents数量和artifacts数量'))
    expect(head(records[6].prompt)).toBe(head('recruit cookrew teammate修复'))
    // Stable parser identity per file: SessionTurnSync re-watches by `===`.
    expect(traces.watchSpec(node.id)?.parse).toBe(spec?.parse)
  })
})

describe('which rollout a Codex card follows', () => {
  const never = (): string | null => {
    throw new Error('the process must not be asked')
  }

  it('follows the file the process holds when it continues the bound one', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const moved = codexRolloutToFollow(
      { bound: oldFile, held: () => newFile, ownedElsewhere: () => false },
      { sessionsDir: dir, aroundMs: MOVED_AT }
    )
    expect(moved).toBe(newFile)
  })

  it('does not ask the process while no continuation exists on disk', () => {
    const { dir, newFile } = sessionsTree()
    expect(
      codexRolloutToFollow(
        { bound: newFile, held: never, ownedElsewhere: () => false },
        { sessionsDir: dir, aroundMs: MOVED_AT }
      )
    ).toBeNull()
  })

  it('finds an old continuation only when asked to look everywhere', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const weekLater = MOVED_AT + 7 * 86_400_000
    const input = { bound: oldFile, held: () => newFile, ownedElsewhere: () => false }
    expect(codexRolloutToFollow(input, { sessionsDir: dir, aroundMs: weekLater })).toBeNull()
    expect(
      codexRolloutToFollow(input, { sessionsDir: dir, aroundMs: weekLater, everywhere: true })
    ).toBe(newFile)
  })

  it('stays put on a held file that is not this conversation, or that another card owns', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const scope = { sessionsDir: dir, aroundMs: MOVED_AT }
    const stranger = path.join(dir, '2026/11/13/rollout-2026-11-13T23-00-00-other.jsonl')
    writeFileSync(stranger, readFileSync(newFile, 'utf8').replaceAll('c0de', 'f00d'))
    expect(
      codexRolloutToFollow({ bound: oldFile, held: () => stranger, ownedElsewhere: () => false }, scope)
    ).toBeNull()
    expect(
      codexRolloutToFollow({ bound: oldFile, held: () => newFile, ownedElsewhere: () => true }, scope)
    ).toBeNull()
    expect(
      codexRolloutToFollow({ bound: oldFile, held: () => null, ownedElsewhere: () => false }, scope)
    ).toBeNull()
  })
})

describe('the history_base chain itself', () => {
  it('a base that appears LATE is still picked up (a mid-write read never caches)', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const lines = readFileSync(newFile, 'utf8').split('\n')
    // Strip the header's history_base: the walk sees an ordinary rollout.
    const plain = JSON.parse(lines[0])
    delete plain.payload.history_base
    writeFileSync(newFile, [JSON.stringify(plain), ...lines.slice(1)].join('\n'))
    expect(codexBaseChain(newFile, { sessionsDir: dir })).toEqual([])
    // The real backtrack's write lands a moment later; the SAME pass finds it.
    const meta = JSON.parse(lines[0])
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    const chain = codexBaseChain(newFile, { sessionsDir: dir })
    expect(chain).toEqual([{ file: oldFile, endByteOffset: meta.payload.history_base.end_byte_offset }])
  })

  it('a base that never comes resolves to nothing, permanently on the safe side', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const lines = readFileSync(newFile, 'utf8').split('\n')
    const meta = JSON.parse(lines[0])
    meta.payload.history_base.end_byte_offset = 42
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(false)
    // And the stream of such a file is the file alone — never a guess.
    const acc = codexBaseChain(newFile, { sessionsDir: dir })
    expect(acc).toEqual([])
  })

  it('validates a whole-file cut against the final ordinal', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const lines = readFileSync(newFile, 'utf8').split('\n')
    const meta = JSON.parse(lines[0])
    const oldLines = readFileSync(oldFile, 'utf8').trimEnd().split('\n')
    const lastOrdinal = JSON.parse(oldLines[oldLines.length - 1]).ordinal
    meta.payload.history_base.end_byte_offset = statSync(oldFile).size
    meta.payload.history_base.end_ordinal_exclusive = lastOrdinal + 1
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(true)
    meta.payload.history_base.end_ordinal_exclusive = lastOrdinal + 2
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(false)
  })

  it('rejects a history_base that names another thread', () => {
    const { dir, oldFile, newFile } = sessionsTree()
    const other = '01a1cdcf-0000-7000-8000-00000000f00d'
    const otherFile = oldFile.replace(THREAD, other)
    writeFileSync(otherFile, readFileSync(oldFile, 'utf8').replaceAll(THREAD, other))
    const lines = readFileSync(newFile, 'utf8').split('\n')
    const meta = JSON.parse(lines[0])
    meta.payload.history_base.thread_id = other
    writeFileSync(newFile, [JSON.stringify(meta), ...lines.slice(1)].join('\n'))
    expect(codexRolloutContinues(newFile, oldFile, { sessionsDir: dir })).toBe(false)
  })
})
