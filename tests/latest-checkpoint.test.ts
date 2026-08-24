import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

const T0 = Date.parse('2026-08-24T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function turnLines(n: number): string {
  return Array.from({ length: n }, (_, i) => [
    JSON.stringify({
      type: 'user',
      uuid: `u${i}`,
      timestamp: iso(T0 + i * 1000),
      message: { role: 'user', content: `ask ${i}` },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(T0 + i * 1000 + 500),
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] },
    }),
  ].join('\n')).join('\n')
}

/** A bound Claude terminal whose session file lives under a temp projectsDir. */
function boundClaude(): {
  store: WorkspaceStore
  file: string
  reader: TraceReader
  nodeId: string
} {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'lc-store-')))
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'lc-proj-'))
  const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
  mkdirSync(dir, { recursive: true })
  // claudeWatchFile (unlike page's resolver) requires a valid UUID session id.
  const sid = '9703d0f7-1057-43aa-80d9-c467077ede01'
  const file = path.join(dir, `${sid}.jsonl`)
  writeFileSync(file, turnLines(3) + '\n')
  const node = store.addNode({
    kind: 'terminal',
    id: 't-lc',
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    claudeSessionId: sid,
  } as TerminalNodeData) as TerminalNodeData
  return { store, file, reader: new TraceReader(store, { projectsDir }), nodeId: node.id }
}

describe('TraceReader.latestCheckpoint', () => {
  it('returns the LAST complete turn (not the whole history)', async () => {
    const { reader, nodeId } = boundClaude()
    const cp = await reader.latestCheckpoint(nodeId)
    expect(cp).not.toBeNull()
    expect(cp!.prompt).toBe('ask 2') // 0..2, last one
    expect(cp!.reply).toBe('reply 2')
  })

  it('reflects a new turn after the file grows (append → fresh value)', async () => {
    const { reader, nodeId, file } = boundClaude()
    expect((await reader.latestCheckpoint(nodeId))!.reply).toBe('reply 2')
    // A new turn lands.
    appendFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: 'u9',
        timestamp: iso(T0 + 9000),
        message: { role: 'user', content: 'ask NINE' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          timestamp: iso(T0 + 9500),
          message: { role: 'assistant', content: [{ type: 'text', text: 'reply NINE' }] },
        }) +
        '\n',
    )
    const cp = await reader.latestCheckpoint(nodeId)
    expect(cp!.prompt).toBe('ask NINE')
    expect(cp!.reply).toBe('reply NINE')
  })

  it('stat-guarded cache: an unchanged file returns the SAME value object (no re-parse)', async () => {
    const { reader, nodeId } = boundClaude()
    // The first call reads+parses and caches. Subsequent calls on an unchanged
    // file (same size+mtime) return the cached object by IDENTITY — proof the
    // read/parse path was skipped. This is the fleet-poll fast path: N idle
    // cards cost N stats, not N parses.
    const first = await reader.latestCheckpoint(nodeId)
    for (let i = 0; i < 25; i++) {
      const again = await reader.latestCheckpoint(nodeId)
      expect(again).toBe(first) // reference identity — cache hit, not a re-read
    }
  })

  it('cache invalidates on growth: the value object changes after an append', async () => {
    const { reader, nodeId, file } = boundClaude()
    const before = await reader.latestCheckpoint(nodeId)
    appendFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: 'u-grow',
        timestamp: iso(T0 + 20000),
        message: { role: 'user', content: 'grown' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          timestamp: iso(T0 + 20500),
          message: { role: 'assistant', content: [{ type: 'text', text: 'grown reply' }] },
        }) +
        '\n',
    )
    const after = await reader.latestCheckpoint(nodeId)
    expect(after).not.toBe(before) // fresh read, not the stale cache
    expect(after!.reply).toBe('grown reply')
  })

  it('returns null (cached) for a terminal with no bound session file', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'lc-none-')))
    store.addNode({
      kind: 'terminal',
      id: 't-none',
      name: 'Shell',
      preset: 'Shell',
      command: '',
      cwd: '/tmp',
      orch: false,
      role: null,
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    } as TerminalNodeData)
    const reader = new TraceReader(store)
    expect(await reader.latestCheckpoint('t-none')).toBeNull()
  })
})
