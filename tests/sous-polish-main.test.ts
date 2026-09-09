import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { polishTranscript } from '../src/main/sous-polish'
import { resetRemoteSousCache } from '../src/main/sous-remote-config'

// Local path only: never read the developer's ~/.cookrew/sous.json.
process.env.COOKREW_SOUS_CONFIG = '/nonexistent/cookrew-sous-test.json'
beforeEach(() => resetRemoteSousCache())
afterEach(() => vi.unstubAllGlobals())

/** Stand in for Ollama; `reply` may be text, a status, an Error, or a hang. */
function ollama(reply: (prompt: string) => unknown): { prompts: string[]; systems: string[] } {
  const prompts: string[] = []
  const systems: string[] = []
  const fetchFn = async (_url: string, init: { body: string; signal: AbortSignal }): Promise<unknown> => {
    const body = JSON.parse(init.body) as { prompt: string; system: string }
    prompts.push(body.prompt)
    systems.push(body.system)
    const r = reply(body.prompt)
    if (r instanceof Error) throw r
    if (r === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
      })
    }
    if (typeof r === 'number') return { ok: false, status: r }
    return { ok: true, json: async () => ({ response: r }) }
  }
  vi.stubGlobal('fetch', fetchFn)
  return { prompts, systems }
}

const said = '嗯那个帮我写一个今日打卡然后发到小红书，不对，发到朋友圈'

describe('polishTranscript', () => {
  it('returns the cleaned text and says it was polished', async () => {
    const { systems, prompts } = ollama(() => '帮我写一个今日打卡，发到朋友圈。')
    expect(await polishTranscript(said)).toEqual({ text: '帮我写一个今日打卡，发到朋友圈。', polished: true })
    expect(systems[0]).toContain('self-corrections')
    expect(prompts[0]).toContain(said)
  })
  it('a short sentence is not sent anywhere', async () => {
    const { prompts } = ollama(() => 'x')
    expect(await polishTranscript('run tests')).toEqual({ text: 'run tests', polished: false })
    expect(prompts).toHaveLength(0)
  })
  it('over budget, the raw words land — never nothing, never late', async () => {
    ollama(() => 'hang')
    const started = Date.now()
    const result = await polishTranscript(said, { budgetMs: 30 })
    expect(result).toEqual({ text: said, polished: false })
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('an unusable answer, a server error, or no server at all all fall back to the raw words', async () => {
    ollama(() => 'You clean up dictated speech…')
    expect(await polishTranscript(said)).toEqual({ text: said, polished: false })
    ollama(() => 500)
    expect(await polishTranscript(said)).toEqual({ text: said, polished: false })
    ollama(() => new Error('ECONNREFUSED'))
    expect(await polishTranscript(said)).toEqual({ text: said, polished: false })
  })
})
