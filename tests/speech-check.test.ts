// TEMPORARY (owner, 2026-11-05): why does Web Speech do nothing on the owner's
// Android, with no message? The box swallows `aborted` and `no-speech`, so this
// one-shot check reports every raw event to the phone's log.

import { describe, expect, it } from 'vitest'
import { runSpeechCheck, type CheckRecognizer } from '../src/renderer/src/speech-check'

type Script = (r: CheckRecognizer) => void

function fakeCtor(scripts: Script[]) {
  const made: CheckRecognizer[] = []
  const Ctor = function (this: CheckRecognizer) {
    const r = this
    const script = scripts[made.length]
    r.start = () => setTimeout(() => script?.(r), 0)
    r.abort = () => {
      r.aborted = true
    }
    made.push(r)
  } as unknown as new () => CheckRecognizer
  return { Ctor, made }
}

const run = async (scripts: Script[], over = {}) => {
  const lines: Record<string, unknown>[] = []
  const shown: string[] = []
  const { Ctor, made } = fakeCtor(scripts)
  await runSpeechCheck({ Ctor, report: (l) => lines.push(l), show: (s) => shown.push(s), listenMs: 20, endMs: 20, ...over })
  return { lines, shown, made }
}

describe('the speech check', () => {
  it('tries as the app does, then in zh-CN, reporting each raw event in order', async () => {
    const say: Script = (r) => {
      r.onstart?.({})
      r.onerror?.({ error: 'aborted', message: 'client' })
      r.onend?.({})
    }
    const { lines, made } = await run([say, say])
    expect(made).toHaveLength(2)
    expect(made[0].lang).toBeUndefined()
    expect(made[1].lang).toBe('zh-CN')
    expect(made.every((r) => r.interimResults)).toBe(true)
    const first = lines.filter((l) => l.attempt === 'as-app').map((l) => l.event)
    expect(first).toEqual(['begin', 'start', 'error', 'end'])
    expect(lines.find((l) => l.event === 'error')).toMatchObject({ error: 'aborted', message: 'client' })
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i))
  })

  it('reports the words of a result, and whether they were final', async () => {
    const hear: Script = (r) => {
      r.onresult?.({ results: Object.assign([Object.assign([{ transcript: '你好' }], { isFinal: true })], {}) })
      r.onend?.({})
    }
    const { lines } = await run([hear, hear])
    expect(lines.find((l) => l.event === 'result')).toMatchObject({ transcript: '你好', isFinal: true })
  })

  it('a recognizer that never ends is aborted, and said to have gone silent', async () => {
    const { lines, made } = await run([() => undefined, (r) => r.onend?.({})])
    expect(made[0].aborted).toBe(true)
    expect(lines.filter((l) => l.attempt === 'as-app').map((l) => l.event)).toEqual(['begin', 'abort-sent', 'no-end'])
    expect(lines.some((l) => l.attempt === 'zh-CN' && l.event === 'end')).toBe(true)
  })

  it('a start that throws is a line, not a crash, and the next attempt still runs', async () => {
    const Throwing = function (this: CheckRecognizer) {
      this.abort = () => undefined
      this.start = () => {
        throw new Error('already started')
      }
    } as unknown as new () => CheckRecognizer
    const { lines } = await run([], { Ctor: Throwing })
    expect(lines.filter((l) => l.event === 'start-threw').map((l) => l.attempt)).toEqual(['as-app', 'zh-CN'])
  })

  it('no recognizer at all is said, and nothing is started', async () => {
    const { lines } = await run([], { Ctor: null })
    expect(lines).toEqual([expect.objectContaining({ event: 'no-recognizer', seq: 0 })])
  })
})
