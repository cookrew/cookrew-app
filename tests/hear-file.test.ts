import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hearRecording, type HearFileOptions } from '../src/main/hear-file'

/** A helper the test answers for: what each locale says, and how it exits. */
type Script = { lines?: string[]; code?: number | null; fail?: Error; hang?: boolean; exitFirst?: boolean }

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  exited = false
  killed: string[] = []
  kill(signal: string): boolean {
    if (this.exited) return false
    this.killed.push(signal)
    this.exited = true
    this.emit('close', null, signal)
    return true
  }
}

function harness(scripts: Record<string, Script>, locales = Object.keys(scripts)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hear-file-'))
  const binary = path.join(dir, 'cr-listen')
  writeFileSync(binary, '')
  const calls: string[][] = []
  const children: FakeChild[] = []
  const seenFiles: { file: string; there: boolean }[] = []
  const spawnFn = ((_bin: string, args: string[]) => {
    calls.push(args)
    const file = args[args.indexOf('--file') + 1]
    seenFiles.push({ file, there: existsSync(file) })
    const locale = args[args.indexOf('--locale') + 1]
    const script = scripts[locale] ?? {}
    const child = new FakeChild()
    children.push(child)
    setTimeout(() => {
      if (script.fail) return child.emit('error', script.fail)
      // Node may report the exit before the stdout chunk the child wrote last.
      if (script.exitFirst) child.emit('exit', 0, null)
      for (const line of script.lines ?? []) child.stdout.emit('data', `${line}\n`)
      if (script.hang) return
      child.exited = true
      child.emit('close', script.code === undefined ? 0 : script.code, null)
    }, 1)
    return child
  }) as unknown as HearFileOptions['spawnFn']
  const options: HearFileOptions = { binary, locales: () => locales, hints: () => ['Sous', 'Cookrew'], spawnFn, dir }
  return { options, calls, seenFiles, dir, children }
}

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
const onMac = platform() === 'darwin'

describe.runIf(onMac)('hearRecording', () => {
  it('hears one recording in every locale: the first is the text, the rest alternates', async () => {
    const h = harness({
      'zh-CN': { lines: ['{"ready":true}', '{"final":"让QQ给修一下字体大小"}'] },
      'en-US': { lines: ['{"final":"ask Cookrew Dev to fix the font size"}'] }
    })
    await expect(hearRecording(h.options, audio)).resolves.toEqual({
      text: '让QQ给修一下字体大小',
      alternates: { 'en-US': 'ask Cookrew Dev to fix the font size' }
    })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0]).toEqual(expect.arrayContaining(['--locale', 'zh-CN', '--hint', 'Sous', '--hint', 'Cookrew']))
    // Both ears read the same file, and it is gone afterwards.
    expect(new Set(h.seenFiles.map((f) => f.file)).size).toBe(1)
    expect(h.seenFiles[0].file.startsWith(h.dir)).toBe(true)
    expect(h.seenFiles.every((f) => f.there)).toBe(true)
    expect(existsSync(h.seenFiles[0].file)).toBe(false)
  })

  it('silence is empty words, not an error', async () => {
    const h = harness({ 'en-US': { lines: ['{"final":""}'] } })
    await expect(hearRecording(h.options, audio)).resolves.toEqual({ text: '', alternates: {} })
  })

  it("a clean exit without a final is silence; a crash is the primary's fault", async () => {
    await expect(hearRecording(harness({ 'en-US': { code: 0 } }).options, audio)).resolves.toEqual({ text: '', alternates: {} })
    await expect(hearRecording(harness({ 'en-US': { code: 3 } }).options, audio)).rejects.toThrow('speech helper exited 3')
  })

  it("the primary's error fails the whole; an alternate's only drops that alternate", async () => {
    const primaryFails = harness({ 'zh-CN': { lines: ['{"error":"recognition failed: x"}'], code: 1 }, 'en-US': { lines: ['{"final":"hi"}'] } })
    await expect(hearRecording(primaryFails.options, audio)).rejects.toThrow('recognition failed: x')
    expect(existsSync(primaryFails.seenFiles[0].file)).toBe(false)
    const alternateFails = harness({ 'zh-CN': { lines: ['{"final":"你好"}'] }, 'en-US': { fail: new Error('ENOENT') } })
    await expect(hearRecording(alternateFails.options, audio)).resolves.toEqual({ text: '你好', alternates: {} })
  })

  it('an alternate slower than the beat after the primary is left out, and killed', async () => {
    const h = harness({ 'zh-CN': { lines: ['{"final":"修一下字体大小"}'] }, 'en-US': { hang: true } })
    const started = Date.now()
    await expect(hearRecording({ ...h.options, settleMs: 30 }, audio)).resolves.toEqual({ text: '修一下字体大小', alternates: {} })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(h.children[1].killed).toEqual(['SIGKILL'])
    expect(h.children[0].killed).toEqual([])
  })

  it('gives each helper the recording\'s own length plus the margin', async () => {
    const h = harness({ 'en-US': { lines: ['{"final":"x"}'] } })
    await hearRecording({ ...h.options, maxSeconds: 10 }, new Uint8Array(32000 * 50))
    expect(h.calls[0].slice(0, 2)).toEqual(['--max-seconds', '60'])
  })

  it('a final printed in the same breath as the exit still counts', async () => {
    const h = harness({ 'en-US': { lines: ['{"final":"spoken"}'], exitFirst: true } })
    await expect(hearRecording(h.options, audio)).resolves.toEqual({ text: 'spoken', alternates: {} })
  })

  it('refuses empty and oversized recordings before any helper starts', async () => {
    const h = harness({ 'en-US': { lines: ['{"final":"x"}'] } })
    await expect(hearRecording(h.options, new Uint8Array())).rejects.toThrow('empty')
    await expect(hearRecording({ ...h.options, maxBytes: 4 }, audio)).rejects.toThrow('too long')
    expect(h.calls).toHaveLength(0)
  })

  it('refuses when the helper is not built', async () => {
    const h = harness({ 'en-US': {} })
    await expect(hearRecording({ ...h.options, binary: path.join(h.dir, 'missing') }, audio)).rejects.toThrow('not built')
  })
})
