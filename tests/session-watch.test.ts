// TraceReader.watchSpec — the session-file watch contract every 'file'-
// capable harness must satisfy so SessionTurnSync can reconcile durable turn
// history (endpoint rail titles/prompts) from the agent-owned session file,
// not from PTY scraping.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import { piNodeSessionDir } from '../src/main/pi-bind'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `t-${Math.floor(Math.random() * 1e9)}`,
    name: 'Agent',
    preset: 'Agent',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

function storeWith(node: TerminalNodeData): { store: WorkspaceStore; node: TerminalNodeData } {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'watch-store-')))
  return { store, node: store.addNode(node) as TerminalNodeData }
}

describe('TraceReader.watchSpec', () => {
  it('claude: watches the session file path even before it exists (minted id)', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'watch-claude-'))
    const sessionId = '0e3f412a-718b-4da9-a059-9b6162ee7192'
    const { store, node } = storeWith(terminal({ command: 'claude', claudeSessionId: sessionId }))
    const spec = new TraceReader(store, { projectsDir }).watchSpec(node.id)
    expect(spec).not.toBeNull()
    expect(spec!.file).toBe(path.join(projectsDir, claudeProjectSlug('/work/repo'), `${sessionId}.jsonl`))
  })

  it('claude: a non-UUID session id is refused (defense-in-depth at the watch boundary)', () => {
    const { store, node } = storeWith(terminal({ command: 'claude', claudeSessionId: '../../etc/x' }))
    const spec = new TraceReader(store, {
      projectsDir: mkdtempSync(path.join(tmpdir(), 'watch-claude-'))
    }).watchSpec(node.id)
    expect(spec).toBeNull()
  })

  it('pi: resolves the bound session inside the terminal-exclusive dir', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'watch-pi-'))
    const { store, node } = storeWith(
      terminal({ command: 'pi', claudeSessionId: null, piSessionId: 'sess-9' })
    )
    const dir = piNodeSessionDir(node.id, { rootDir: root })
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '2026-08-05_sess-9.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'sess-9', cwd: '/work/repo' }),
        JSON.stringify({
          type: 'message', id: 'u1', parentId: null,
          message: { role: 'user', content: 'pi prompt', timestamp: T0 }
        }),
        JSON.stringify({
          type: 'message', id: 'a1', parentId: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'pi reply' }], timestamp: T0 + 1000 }
        })
      ].join('\n') + '\n'
    )
    const spec = new TraceReader(store, { piSessionsRoot: root }).watchSpec(node.id)
    expect(spec).not.toBeNull()
    expect(spec!.file).toBe(file)
    const turns = spec!.parse(['ignored'])
    expect(typeof spec!.parse).toBe('function')
    void turns
  })

  it('pi: unbound terminal (no piSessionId yet) has no watch spec', () => {
    const { store, node } = storeWith(
      terminal({ command: 'pi', claudeSessionId: null, piSessionId: null })
    )
    const spec = new TraceReader(store, {
      piSessionsRoot: mkdtempSync(path.join(tmpdir(), 'watch-pi-'))
    }).watchSpec(node.id)
    expect(spec).toBeNull()
  })

  it('codex: watches the bound rollout inside the sessions tree', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'watch-codex-'))
    const day = path.join(base, '2026', '08', '05')
    mkdirSync(day, { recursive: true })
    const file = path.join(day, 'rollout-x-s1.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: new Date(T0).toISOString(), type: 'session_meta',
          payload: { session_id: 's1', timestamp: new Date(T0).toISOString(), cwd: '/work/repo' }
        }),
        JSON.stringify({
          timestamp: new Date(T0 + 1000).toISOString(), type: 'event_msg',
          payload: { type: 'user_message', message: 'codex prompt' }
        })
      ].join('\n') + '\n'
    )
    const { store, node } = storeWith(
      terminal({ command: 'codex', claudeSessionId: null, codexSessionRef: file })
    )
    const spec = new TraceReader(store, { codexSessionsDir: base }).watchSpec(node.id)
    expect(spec).not.toBeNull()
    expect(spec!.file).toBe(file)
  })

  it('codex: a ref outside the sessions tree is refused (planted-ref defense)', () => {
    const { store, node } = storeWith(
      terminal({ command: 'codex', claudeSessionId: null, codexSessionRef: '/etc/passwd' })
    )
    const spec = new TraceReader(store, {
      codexSessionsDir: mkdtempSync(path.join(tmpdir(), 'watch-codex-'))
    }).watchSpec(node.id)
    expect(spec).toBeNull()
  })

  it('plain shells and opencode (scrape-only) have no watch spec', () => {
    const { store, node } = storeWith(terminal({ command: 'zsh', claudeSessionId: null }))
    expect(new TraceReader(store).watchSpec(node.id)).toBeNull()

    const oc = storeWith(terminal({ command: 'opencode', claudeSessionId: null, opencodeSessionId: 'ses_abc' }))
    expect(new TraceReader(oc.store).watchSpec(oc.node.id)).toBeNull()
  })
})
