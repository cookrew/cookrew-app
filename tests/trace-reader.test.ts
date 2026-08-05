import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import { CODEX_SPAWN_WINDOW_MS, resolveCodexRollout } from '../src/main/codex-bind'
import { piNodeSessionDir } from '../src/main/pi-bind'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

const T0 = Date.parse('2026-07-22T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `t-${Math.floor(Math.random() * 1e9)}`,
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

function rollout(dir: string, name: string, cwd: string, tsMs: number, prompts: string[]): string {
  const lines = [
    JSON.stringify({
      timestamp: iso(tsMs),
      type: 'session_meta',
      payload: { session_id: name, timestamp: iso(tsMs), cwd }
    }),
    ...prompts.flatMap((prompt, i) => [
      JSON.stringify({
        timestamp: iso(tsMs + i * 1000),
        type: 'event_msg',
        payload: { type: 'user_message', message: prompt }
      }),
      JSON.stringify({
        timestamp: iso(tsMs + i * 1000 + 500),
        type: 'event_msg',
        payload: { type: 'agent_message', message: `re: ${prompt}`, phase: 'final_answer' }
      })
    ])
  ]
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-x-${name}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** Day-dir for T0 under a temp codex sessions root. */
function dayDir(base: string): string {
  const d = new Date(T0)
  return path.join(
    base,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0')
  )
}

describe('resolveCodexRollout (binder)', () => {
  it('binds the newest cwd-matching rollout inside the spawn window', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-bind-'))
    const day = dayDir(base)
    rollout(day, 'old', '/work/repo', T0 - CODEX_SPAWN_WINDOW_MS - 60_000, ['old'])
    const fresh = rollout(day, 'fresh', '/work/repo', T0 + 5_000, ['fresh'])
    rollout(day, 'other-cwd', '/elsewhere', T0 + 6_000, ['x'])

    expect(resolveCodexRollout({ cwd: '/work/repo', spawnedAt: T0, sessionsDir: base })).toBe(fresh)
  })

  it('lazy bind (spawnedAt null) drops the time constraint but keeps cwd', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'codex-bind-'))
    const day = dayDir(base)
    const only = rollout(day, 'later', '/work/repo', T0 - CODEX_SPAWN_WINDOW_MS * 3, ['x'])
    // Lazy scan is anchored to "now" — for the test, scan the rollout's own day.
    expect(
      resolveCodexRollout({ cwd: '/work/repo', spawnedAt: T0 - CODEX_SPAWN_WINDOW_MS * 3, sessionsDir: base })
    ).toBe(only)
    expect(resolveCodexRollout({ cwd: '/nope', spawnedAt: T0, sessionsDir: base })).toBeNull()
  })
})

describe('TraceReader (paged trace API over agent files)', () => {
  it('serves Claude blocks by identity window from the bound session file', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    const lines = [1, 2, 3].flatMap((i) => [
      JSON.stringify({
        type: 'user', uuid: `u${i}`, timestamp: iso(T0 + i * 1000),
        message: { role: 'user', content: `ask ${i}` }
      }),
      JSON.stringify({
        type: 'assistant', timestamp: iso(T0 + i * 1000 + 500),
        message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] }
      })
    ])
    writeFileSync(path.join(dir, 'sess.jsonl'), lines.join('\n') + '\n')
    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData

    const reader = new TraceReader(store, { projectsDir })
    const page = await reader.page(node.id, { beforeIndex: 3, limit: 5 })
    expect(page.source).toBe('claude')
    expect(page.total).toBe(3)
    expect(page.blocks.map((b) => b.id)).toEqual(['u1', 'u2'])
    expect(page.blocks[0].prompt).toBe('ask 1')
  })

  it('reads the AUTHORITATIVE bound rollout; an unbound codex yields empty (no mtime rebind)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const base = mkdtempSync(path.join(tmpdir(), 'trace-codex-'))
    const file = rollout(dayDir(base), 'sess', '/work/repo', Date.now(), ['hello codex'])
    // Unbound codex node: the trace reader must NOT guess a rollout (the bind
    // is deterministic at spawn via lsof, never an mtime scan here).
    const unbound = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null })
    ) as TerminalNodeData
    const reader = new TraceReader(store, { codexSessionsDir: base })
    expect(await reader.page(unbound.id, {})).toEqual({ blocks: [], total: 0, source: null })
    // Bound codex node (ref set by the spawn binder) → reads exactly that file.
    const bound = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null, codexSessionRef: file })
    ) as TerminalNodeData
    store.updateNodeUnsafe(bound.id, { codexSessionRef: file })
    const page = await reader.page(bound.id, {})
    expect(page.source).toBe('codex')
    expect(page.blocks[0]).toMatchObject({ id: 'p1', prompt: 'hello codex' })
  })

  it('serves the exact cwd-scoped Pi session bound to the node', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trace-pi-'))
    const cwd = path.join(root, 'work', 'repo')
    const sessionsRoot = path.join(root, 'pi-sessions')
    const id = 'pi-session-1'
    mkdirSync(cwd, { recursive: true })
    const nodeId = 'pi-reader-node'
    const dir = piNodeSessionDir(nodeId, { rootDir: sessionsRoot })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `2026-08-03T00-00-00-000Z_${id}.jsonl`),
      [
        { type: 'session', version: 3, id, cwd },
        { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'hello pi', timestamp: T0 } },
        { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }], timestamp: T0 + 1 } }
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    )
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const node = store.addNode(
      terminal({ id: nodeId, preset: 'Pi', command: 'pi', cwd, claudeSessionId: null, piSessionId: id })
    ) as TerminalNodeData

    const page = await new TraceReader(store, { piSessionsRoot: sessionsRoot }).page(node.id, {})
    expect(page.source).toBe('pi')
    expect(page.blocks).toEqual([
      expect.objectContaining({ id: 'u1', prompt: 'hello pi', reply: 'hello back' })
    ])
  })

  it('returns an empty page for unbound/sessionless terminals', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const node = store.addNode(terminal({ command: 'claude', claudeSessionId: null }))
    const reader = new TraceReader(store, {})
    expect(await reader.page(node.id, {})).toEqual({ blocks: [], total: 0, source: null })
  })
})


describe('TraceReader security + disambiguation (integration takeover)', () => {
  it('refuses a Pi file whose header cwd does not match the node', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trace-pi-sec-'))
    const cwd = path.join(root, 'work', 'repo')
    const sessionsRoot = path.join(root, 'pi-sessions')
    const id = 'pi-session-safe'
    mkdirSync(cwd, { recursive: true })
    const nodeId = 'pi-security-node'
    const dir = piNodeSessionDir(nodeId, { rootDir: sessionsRoot })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/other/project' })}\n`
    )
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-pi-sec-store-')))
    const node = store.addNode(
      terminal({ id: nodeId, preset: 'Pi', command: 'pi', cwd, claudeSessionId: null, piSessionId: id })
    ) as TerminalNodeData

    expect(await new TraceReader(store, { piSessionsRoot: sessionsRoot }).page(node.id, {})).toEqual({
      blocks: [], total: 0, source: null
    })
  })

  it('rejects a planted codexSessionRef outside the sessions tree (never read, no fallback)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-sec-')))
    const base = mkdtempSync(path.join(tmpdir(), 'trace-sec-codex-'))
    const evil = path.join(mkdtempSync(path.join(tmpdir(), 'evil-')), 'secrets.jsonl')
    writeFileSync(evil, '{"type":"session_meta","payload":{}}\n')
    const node = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null })
    ) as TerminalNodeData
    store.updateNodeUnsafe(node.id, { codexSessionRef: evil })

    const reader = new TraceReader(store, { codexSessionsDir: base })
    // Out-of-tree ref is rejected → no trace, and the evil file is never read
    // (and no mtime fallback that could grab a stray).
    expect(await reader.page(node.id, {})).toEqual({ blocks: [], total: 0, source: null })
  })

  it('each codex terminal reads its OWN bound rollout — no cross-read', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-two-')))
    const base = mkdtempSync(path.join(tmpdir(), 'trace-two-codex-'))
    const first = rollout(dayDir(base), 'one', '/work/repo', Date.now(), ['one'])
    const second = rollout(dayDir(base), 'two', '/work/repo', Date.now() - 1000, ['two'])
    const a = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null, codexSessionRef: first })
    ) as TerminalNodeData
    store.updateNodeUnsafe(a.id, { codexSessionRef: first })
    const b = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null, codexSessionRef: second })
    ) as TerminalNodeData
    store.updateNodeUnsafe(b.id, { codexSessionRef: second })

    const reader = new TraceReader(store, { codexSessionsDir: base })
    expect((await reader.page(a.id, {})).blocks[0]?.prompt).toBe('one')
    expect((await reader.page(b.id, {})).blocks[0]?.prompt).toBe('two')
  })

  it('appends incrementally: growth is parsed without a full re-read', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-incr-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-incr-proj-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'sess.jsonl')
    const entry = (i: number): string =>
      JSON.stringify({
        type: 'user', uuid: `u${i}`, timestamp: iso(T0 + i * 1000),
        message: { role: 'user', content: `ask ${i}` }
      })
    writeFileSync(file, entry(1) + '\n')
    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })

    expect((await reader.page(node.id, {})).total).toBe(1)
    // Append (like the live agent does) — the next page picks it up.
    writeFileSync(file, entry(1) + '\n' + entry(2) + '\n')
    const grown = await reader.page(node.id, {})
    expect(grown.total).toBe(2)
    expect(grown.blocks.map((b) => b.id)).toEqual(['u1', 'u2'])
    // Shrink (rewind truncation) resets cleanly.
    writeFileSync(file, entry(1) + '\n')
    expect((await reader.page(node.id, {})).total).toBe(1)
  })
})

describe('TraceReader.index (fan listing — the missing producer)', () => {
  it('returns the FULL identity range with prompt snippets (T1..N incl. below-cap)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-idx-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-idx-proj-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    const entry = (i: number): string =>
      JSON.stringify({
        type: 'user', uuid: `u${i}`, timestamp: iso(T0 + i * 1000),
        message: { role: 'user', content: `ask number ${i}` }
      })
    const file = path.join(dir, 'sess.jsonl')
    writeFileSync(file, [1, 2, 3, 4, 5, 6, 7].map(entry).join('\n') + '\n')
    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData

    const reader = new TraceReader(store, { projectsDir })
    const index = await reader.index(node.id)
    expect(index.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(index[0]).toEqual({ index: 1, title: 'ask number 1' })

    // Cached: same listing object while the trace is unchanged…
    expect(await reader.index(node.id)).toBe(index)
    // …and invalidated by growth.
    writeFileSync(file, [1, 2, 3, 4, 5, 6, 7, 8].map(entry).join('\n') + '\n')
    const grown = await reader.index(node.id)
    expect(grown.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('is empty for unbound terminals', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-idx-')))
    const node = store.addNode(terminal({ claudeSessionId: null }))
    expect(await new TraceReader(store, {}).index(node.id)).toEqual([])
  })
})

describe('TraceReader checkpointRefs ∪ boundaryMarkers (lineage union)', () => {
  const prompt = (uuid: string, text: string, ms: number, sid: string): string =>
    JSON.stringify({ type: 'user', uuid, sessionId: sid, timestamp: iso(ms), message: { role: 'user', content: text } })
  const reply = (ms: number, sid: string): string =>
    JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })

  function writeClaude(projectsDir: string, cwd: string, sid: string, prompts: string[], withCompact = false): void {
    const dir = path.join(projectsDir, claudeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    const lines: string[] = []
    prompts.forEach((p, i) => {
      if (withCompact && i === 1) {
        lines.push(JSON.stringify({
          type: 'system', subtype: 'compact_boundary',
          compactMetadata: { trigger: 'auto', preTokens: 50000, postTokens: 2000 }
        }))
      }
      lines.push(prompt(`${sid}-u${i + 1}`, p, T0 + i * 1000, sid), reply(T0 + i * 1000 + 500, sid))
    })
    writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n')
  }

  it('checkpointRefs is current-file-only (indices never drift from the rail)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    writeClaude(projectsDir, '/work/repo', 'old-sess', ['a1', 'a2', 'a3'])
    writeClaude(projectsDir, '/work/repo', 'new-sess', ['b1', 'b2'])
    const node = store.addNode(
      terminal({ claudeSessionId: 'new-sess', sessionLineage: ['old-sess'] })
    ) as TerminalNodeData

    const refs = await new TraceReader(store, { projectsDir }).checkpointRefs(node.id)
    expect(refs.map((r) => r.index)).toEqual([1, 2]) // only new-sess
    expect(refs.map((r) => r.sessionId)).toEqual(['new-sess', 'new-sess'])
    expect(refs[0].id).toBe('new-sess-u1')
  })

  it('emits a ⇥ clear marker at the root of a post-/clear session', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    writeClaude(projectsDir, '/work/repo', 'old-sess', ['a1', 'a2', 'a3'], true)
    writeClaude(projectsDir, '/work/repo', 'new-sess', ['b1', 'b2'])
    const node = store.addNode(
      terminal({ claudeSessionId: 'new-sess', sessionLineage: ['old-sess'] })
    ) as TerminalNodeData

    const markers = await new TraceReader(store, { projectsDir }).boundaryMarkers(node.id)
    // boundaryMarkers is current-file-only; the clear marker sits at the root
    // of the fresh session file created by /clear.
    expect(markers).toEqual([
      { kind: 'clear', afterIndex: 0, previousSessionId: 'old-sess' }
    ])
  })

  it('a node without lineage behaves exactly as before (single segment)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    writeClaude(projectsDir, '/work/repo', 'solo', ['a1', 'a2'])
    const node = store.addNode(terminal({ claudeSessionId: 'solo' })) as TerminalNodeData

    const refs = await new TraceReader(store, { projectsDir }).checkpointRefs(node.id)
    expect(refs.map((r) => r.index)).toEqual([1, 2])
    expect(refs.map((r) => r.sessionId)).toEqual(['solo', 'solo'])
    expect(await new TraceReader(store, { projectsDir }).boundaryMarkers(node.id)).toEqual([])
  })

  it('H6: one reader polling a GROWING file sees new refs/markers (incremental path, no full re-read)', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    writeClaude(projectsDir, '/work/repo', 'live', ['a1', 'a2'])
    const node = store.addNode(terminal({ claudeSessionId: 'live' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })

    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1, 2])
    expect(await reader.boundaryMarkers(node.id)).toEqual([])

    // The session grows: another turn plus a compact boundary. The SAME
    // reader must observe both through the incremental ingest.
    const file = path.join(projectsDir, claudeProjectSlug('/work/repo'), 'live.jsonl')
    const appended = [
      JSON.stringify({
        type: 'system', subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 50000, postTokens: 2000 }
      }),
      prompt('live-u3', 'a3', T0 + 2000, 'live'),
      reply(T0 + 2500, 'live')
    ]
    appendFileSync(file, appended.join('\n') + '\n')

    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1, 2, 3])
    const markers = await reader.boundaryMarkers(node.id)
    expect(markers).toEqual([
      { kind: 'compact', afterIndex: 2, preTokens: 50000, postTokens: 2000 }
    ])
  })

  it('H6: a SHRINK (/rewind truncation) resets the cache instead of serving stale refs', async () => {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
    writeClaude(projectsDir, '/work/repo', 'live', ['a1', 'a2', 'a3'])
    const node = store.addNode(terminal({ claudeSessionId: 'live' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })

    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1, 2, 3])

    writeClaude(projectsDir, '/work/repo', 'live', ['a1']) // truncated
    expect((await reader.checkpointRefs(node.id)).map((r) => r.index)).toEqual([1])
  })
})
