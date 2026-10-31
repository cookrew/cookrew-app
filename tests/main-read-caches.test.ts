// MAIN READS A FILE AGAIN ONLY WHEN IT CHANGED (perf, 2026-11-01: on the
// owner's Mac the rotation scan's heads cost 717 ms and the finality windows
// 460 ms of main-thread time in 10 s, re-reading files that had not changed).
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every file a byte was read from, once per read call. */
const opens: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (file: string, flags?: string) => {
    const handle = await real.open(file, flags)
    const read = handle.read.bind(handle)
    let counted = false
    return Object.assign(handle, {
      read: (...args: Parameters<typeof handle.read>) => {
        if (!counted) opens.push(file)
        counted = true
        return read(...args)
      }
    })
  }
  return { ...real, default: { ...real, open }, open }
})

const { clearHeadCache, readHeadLines } = await import('../src/main/claude-rotation')
const { clearFinalityAnswers, tailIsFinal } = await import('../src/main/stream-finality')

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'main-reads-'))
  opens.length = 0
  clearHeadCache()
  clearFinalityAnswers()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const user = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })
const assistant = (uuid: string, parent: string, stop: string | null) =>
  JSON.stringify({ type: 'assistant', uuid: `${uuid}a`, parentUuid: parent, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: stop } })
const reads = (file: string): number => opens.filter((f) => f === file).length

describe('the finality window', () => {
  it('asks an unchanged transcript once, and again after it grows', async () => {
    const file = path.join(dir, 's.jsonl')
    writeFileSync(file, `${user('u1', 'hi')}\n${assistant('u1', 'u1', null)}\n`)
    const block = { id: 'u1', final: false }
    const first = await tailIsFinal(block, file, 'claude')
    expect(await tailIsFinal(block, file, 'claude')).toBe(first)
    expect(reads(file)).toBe(1)
    // The next prompt arrives: the file changed, so it is read, and the answer can change.
    appendFileSync(file, `${user('u2', 'next')}\n`)
    expect(await tailIsFinal(block, file, 'claude')).toBe(true)
    expect(reads(file)).toBe(2)
  })
})

describe('the head of a session file', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `{"n":${i}}`).join('\n') + '\n'

  it('is read once while the file is unchanged, and kept as it grows once the head was whole', async () => {
    const file = path.join(dir, 'a.jsonl')
    writeFileSync(file, lines(10))
    const head = await readHeadLines(file, 4)
    expect(head).toHaveLength(4)
    expect(await readHeadLines(file, 4)).toEqual(head)
    appendFileSync(file, lines(5))
    expect(await readHeadLines(file, 4)).toEqual(head)
    expect(reads(file)).toBe(1)
  })

  it('is read again when a short head grew, the file got shorter, or it is another file now', async () => {
    const file = path.join(dir, 'b.jsonl')
    writeFileSync(file, lines(2))
    expect(await readHeadLines(file, 4)).toHaveLength(2)
    appendFileSync(file, lines(3))
    expect(await readHeadLines(file, 4)).toHaveLength(4) // short head: read again
    writeFileSync(file, '{"x":1}\n')
    expect(await readHeadLines(file, 4)).toEqual(['{"x":1}']) // shorter: read again
    const other = path.join(dir, 'c.jsonl')
    writeFileSync(other, '{"y":1}\n{"y":2}\n{"y":3}\n{"y":4}\n{"y":5}\n')
    renameSync(other, file) // a new inode at the same path
    expect(await readHeadLines(file, 4)).toEqual(['{"y":1}', '{"y":2}', '{"y":3}', '{"y":4}'])
  })
})
