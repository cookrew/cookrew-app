import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

/**
 * The cold read used to materialise the whole window: chunks, then one
 * concatenated Buffer, then that concatenated with the carry, then one
 * ~90MB string, then the split array — four copies of a session file alive
 * at once, ~450MB of transient heap per read, spent before a single byte is
 * retained. Several of those while a canvas warms up is how a machine
 * arrives at "your system has run out of application memory".
 *
 * Streaming must not change WHAT is read — these pin the equivalence,
 * including the property the old single toString() got for free: a
 * multibyte character split across a chunk boundary must not tear.
 */

const CHUNK = 256 * 1024
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

function turn(index: number, text: string): string[] {
  return [
    JSON.stringify({
      type: 'user',
      uuid: `u${index}`,
      timestamp: iso(T0 + index * 1000),
      message: { role: 'user', content: text }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(T0 + index * 1000 + 500),
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] }
    })
  ]
}

function fixture(): { dir: string; projectsDir: string; store: WorkspaceStore } {
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'trace-store-')))
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'trace-proj-'))
  const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
  mkdirSync(dir, { recursive: true })
  return { dir, projectsDir, store }
}

describe('the trace reader streams its window', () => {
  it('reads past a chunk boundary with a multibyte character sitting ON it', async () => {
    const { dir, projectsDir, store } = fixture()
    const file = path.join(dir, 'sess.jsonl')
    const cactus = Buffer.from('🌵', 'utf8')

    // Build once to find where a cactus lands, then rebuild with the padding
    // that drops one ACROSS byte CHUNK. A boundary that falls in ASCII filler
    // tests nothing: this test only bites when the read cuts a character.
    const build = (pad: number): Buffer => {
      const lines: string[] = []
      let bytes = 0
      let index = 1
      while (bytes < CHUNK + 8000) {
        const filler = 'x'.repeat(index === 1 ? 4000 + pad : 4000)
        const pair = turn(index, `${filler} 🌵 ${index}`)
        lines.push(...pair)
        bytes += pair.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
        index += 1
      }
      return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    }
    const trial = build(0)
    let at = -1
    for (let i = 0; i + 4 <= trial.length && i < CHUNK; i += 1) {
      if (trial.subarray(i, i + 4).equals(cactus)) at = i
    }
    expect(at).toBeGreaterThan(-1)
    const raw = build(CHUNK - 2 - at)
    writeFileSync(file, raw)

    // THE PREMISE, asserted: byte CHUNK is a UTF-8 continuation byte, so the
    // first read ends mid-character and only a byte-carry survives it.
    expect(raw[CHUNK]).toBeGreaterThanOrEqual(0x80)
    expect(raw[CHUNK]).toBeLessThan(0xc0)
    expect(statSync(file).size).toBeGreaterThan(CHUNK)

    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })
    const page = await reader.page(node.id, { limit: 1000 })

    expect(page.total).toBeGreaterThan(1)
    for (const block of page.blocks) {
      expect(block.prompt).toContain('🌵')
      // A torn multibyte character decodes as U+FFFD.
      expect(block.prompt).not.toContain('\ufffd')
    }
  })

  it('an append rejoins a line whose previous read stopped INSIDE a character', async () => {
    const { dir, projectsDir, store } = fixture()
    const file = path.join(dir, 'sess.jsonl')
    const first = turn(1, 'first 🌵')
    const second = turn(2, 'second 🌵')

    // Byte arithmetic, not String.slice: a UTF-16 offset steps over BOTH
    // surrogate halves and leaves the emoji whole, which is how this test
    // used to pass against a deliberately torn carry.
    const whole = Buffer.from(`${[...first, ...second].join('\n')}\n`, 'utf8')
    const cactus = Buffer.from('🌵', 'utf8')
    let at = -1
    for (let i = 0; i + 4 <= whole.length; i += 1) {
      if (whole.subarray(i, i + 4).equals(cactus)) at = i
    }
    expect(at).toBeGreaterThan(-1)
    const cut = at + 2
    expect(whole[cut]).toBeGreaterThanOrEqual(0x80)
    expect(whole[cut]).toBeLessThan(0xc0)
    writeFileSync(file, whole.subarray(0, cut))

    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })
    expect((await reader.page(node.id, { limit: 10 })).total).toBe(1)

    writeFileSync(file, whole)
    const grown = await reader.page(node.id, { limit: 10 })
    expect(grown.total).toBe(2)
    const latest = grown.blocks[grown.blocks.length - 1]
    expect(latest.prompt).toContain('second 🌵')
    expect(latest.prompt).not.toContain('\ufffd')
  })

  it('a line longer than a chunk survives whole, and costs no more than the line', async () => {
    // The O(line²) trap: concatenating the carry per chunk made an unbroken
    // 80MB line cost 3.1GB and 10s. 3MB lines already exist in real
    // transcripts (a pasted build log), so this spans several chunks.
    const { dir, projectsDir, store } = fixture()
    const file = path.join(dir, 'sess.jsonl')
    const long = `${'y'.repeat(CHUNK * 3)} 🌵`
    writeFileSync(file, `${turn(1, long).join('\n')}\n`)

    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })
    const started = Date.now()
    const page = await reader.page(node.id, { limit: 10 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(page.total).toBe(1)
    expect(page.blocks[0].prompt).toContain('🌵')
    expect(page.blocks[0].prompt).not.toContain('\ufffd')
  })

  it('a last line with no trailing newline waits, then completes on append', async () => {
    const { dir, projectsDir, store } = fixture()
    const file = path.join(dir, 'sess.jsonl')
    const pair = turn(1, 'only 🌵')
    writeFileSync(file, pair.join('\n'))

    const node = store.addNode(terminal({ claudeSessionId: 'sess' })) as TerminalNodeData
    const reader = new TraceReader(store, { projectsDir })
    // The unterminated last line is not a line yet — the prompt is, its
    // reply is not, so the turn exists with an empty reply.
    expect((await reader.page(node.id, { limit: 10 })).total).toBe(1)

    writeFileSync(file, `${pair.join('\n')}\n`)
    const done = await reader.page(node.id, { limit: 10 })
    expect(done.total).toBe(1)
    expect(done.blocks[0].reply).toContain('reply 1')
  })
})
