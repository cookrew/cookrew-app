// A NEW AGENT'S NAME (owner, 2026-11-01): a stand-in read off the prompt at
// once, Sous's name once it answers (the way /rename titles a chat), and a
// rename that refuses a name another card of the workspace already wears.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNamePrompt, buildNameSystem, cleanAgentName, nameFromPrompt, sanitizeAgentName, AGENT_NAME_MAX } from '../src/shared/agent-name'
import { EXAMPLE_TASKS } from '../src/shared/first-run-copy'
import { planRename, stillStandIn } from '../src/main/agent-rename'
import { nameAgent } from '../src/main/agent-namer'

describe('cleanAgentName — a name someone typed, made safe to wear', () => {
  it('is one line with single spaces', () => {
    expect(cleanAgentName('  Billing\n\tWebhook  ')).toBe('Billing Webhook')
    expect(cleanAgentName('a\u0007b')).toBe('a b')
  })

  it('is capped by characters, not bytes', () => {
    expect(Array.from(cleanAgentName('名'.repeat(80))).length).toBe(AGENT_NAME_MAX)
  })

  it('is empty when there was no name in it', () => {
    expect(cleanAgentName(' \n ')).toBe('')
  })
})

describe('sanitizeAgentName — what Sous answered, or nothing', () => {
  const zh = '请调研一下herdr的取名功能'
  const en = 'fix the login redirect bug when the session cookie expires'

  it('keeps a short noun phrase in the task’s language', () => {
    expect(sanitizeAgentName('Herdr取名调研', zh)).toBe('Herdr取名调研')
    expect(sanitizeAgentName('Login Redirect Bug', en)).toBe('Login Redirect Bug')
  })

  it('strips labels, quotes, thinking and trailing punctuation in any order', () => {
    expect(sanitizeAgentName('Name: "Login Redirect".', en)).toBe('Login Redirect')
    expect(sanitizeAgentName('「顶栏模型切换」。', '把模型切换放到顶栏右边')).toBe('顶栏模型切换')
    expect(sanitizeAgentName('<think>hmm</think>\n\nLogin Redirect\nextra', en)).toBe('Login Redirect')
  })

  it('takes the name after an arrow, and refuses a task read back', () => {
    expect(sanitizeAgentName(`Task: ${en} -> Session Redirect`, en)).toBe('Session Redirect')
    expect(sanitizeAgentName(`Task: ${en}`, en)).toBeNull()
  })

  it('refuses a Chinese task named in English (the small model’s habit)', () => {
    expect(sanitizeAgentName('Prompt Optimization', '外部模型无法直接进行prompt来创建agent')).toBeNull()
  })

  it('refuses a sentence, an empty answer, and an example echoed back', () => {
    expect(sanitizeAgentName('This agent will look into the login redirect bug', en)).toBeNull()
    expect(sanitizeAgentName('这是一个用来修复登录页面跳转问题的智能体名字', zh)).toBeNull()
    expect(sanitizeAgentName('  \n', en)).toBeNull()
    expect(sanitizeAgentName('"..."', en)).toBeNull()
    expect(sanitizeAgentName('Billing Webhook', en)).toBeNull()
  })

  it('tells the model the language rule and shows it examples', () => {
    expect(buildNameSystem()).toMatch(/same language/)
    expect(buildNameSystem()).toMatch(/-> 设置页深色模式/)
    expect(buildNamePrompt(`  ${'x'.repeat(5000)}  `).length).toBeLessThan(1300)
  })
})

describe('planRename — a name is an address', () => {
  const siblings = [
    { id: 'a', name: 'Conductor' },
    { id: 'b', name: 'Market Scout' },
    { id: 'n', name: 'Market Scout (2)' }
  ]

  it('takes a free name', () => {
    expect(planRename({ id: 'me', current: 'Agent', wanted: ' Billing  Webhook ', siblings, onClash: 'refuse' })).toEqual({ ok: true, name: 'Billing Webhook', changed: true })
  })

  it('refuses a name another card wears, case-blind, when someone typed it', () => {
    const plan = planRename({ id: 'me', current: 'Agent', wanted: 'conductor', siblings, onClash: 'refuse' })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toMatch(/already a card in this workspace/)
  })

  it('suffixes a model’s pick past every taken one', () => {
    expect(planRename({ id: 'me', current: 'Agent', wanted: 'Market Scout', siblings, onClash: 'suffix' })).toEqual({ ok: true, name: 'Market Scout (3)', changed: true })
  })

  it('is not a clash with itself, and says when nothing changes', () => {
    expect(planRename({ id: 'a', current: 'Conductor', wanted: 'Conductor', siblings, onClash: 'refuse' })).toEqual({ ok: true, name: 'Conductor', changed: false })
    expect(planRename({ id: 'a', current: 'Conductor', wanted: 'CONDUCTOR', siblings, onClash: 'refuse' })).toEqual({ ok: true, name: 'CONDUCTOR', changed: true })
  })

  it('refuses an empty name', () => {
    expect(planRename({ id: 'me', current: 'Agent', wanted: '  ', siblings, onClash: 'refuse' }).ok).toBe(false)
  })
})

describe('stillStandIn — a guess never overwrites a choice', () => {
  it('is true while the card wears the stand-in or its suffixed copy', () => {
    expect(stillStandIn('把模型切换放', '把模型切换放')).toBe(true)
    expect(stillStandIn('Login (2)', 'Login')).toBe(true)
    expect(stillStandIn('Login (2)', 'Login (2)')).toBe(true)
  })

  it('is false once renamed, or when the card is gone', () => {
    expect(stillStandIn('Something Else', 'Login')).toBe(false)
    expect(stillStandIn('Login Page', 'Login')).toBe(false)
    expect(stillStandIn(undefined, 'Login')).toBe(false)
  })
})

describe('nameAgent — Sous on the local road', () => {
  beforeEach(() => {
    // No hosted Sous: the config file is absent and no env names one.
    vi.stubEnv('COOKREW_SOUS_CONFIG', '/nonexistent/cookrew-sous.json')
    vi.stubEnv('COOKREW_SOUS_TRANSLATE_URL', '')
    vi.stubEnv('COOKREW_SOUS_TRANSLATE_KEY', '')
    vi.stubEnv('COOKREW_SOUS_REMOTE_MODEL', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  const answering = (body: unknown, status = 200): typeof fetch =>
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch

  it('asks Ollama without thinking and returns the sanitized name', async () => {
    const fetchFn = answering({ response: '"顶栏模型切换"\n' })
    expect(await nameAgent('把模型切换放到顶栏右边', { fetchFn })).toBe('顶栏模型切换')
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toMatch(/\/api\/generate$/)
    const sent = JSON.parse(String(init.body)) as { think: boolean; prompt: string; stream: boolean }
    expect(sent.think).toBe(false)
    expect(sent.stream).toBe(false)
    expect(sent.prompt).toMatch(/把模型切换放到顶栏右边/)
  })

  it('is null on a refused answer, a server error, a timeout, or an empty task — never a throw', async () => {
    expect(await nameAgent('把模型切换放到顶栏右边', { fetchFn: answering({ response: 'Model Switch' }) })).toBeNull()
    expect(await nameAgent('fix the login bug', { fetchFn: answering({ error: 'no model' }, 404) })).toBeNull()
    const timeout = vi.fn(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))) as unknown as typeof fetch
    expect(await nameAgent('fix the login bug', { fetchFn: timeout })).toBeNull()
    const never = vi.fn() as unknown as typeof fetch
    expect(await nameAgent('   ', { fetchFn: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
  })
})

describe('no Ollama on this Mac: the plain name stays, and nothing is said', () => {
  const quiet = (): ReturnType<typeof vi.spyOn> => vi.spyOn(console, 'error').mockImplementation(() => undefined)

  it('reads a refused connection as no name, with no error', async () => {
    const error = quiet()
    const refused = vi.fn(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))) as unknown as typeof fetch
    expect(await nameAgent('fix the login bug', { fetchFn: refused })).toBeNull()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('reads a model not pulled yet the same way', async () => {
    const error = quiet()
    const noModel = vi.fn(() => Promise.resolve(new Response('{"error":"model not found"}', { status: 404 }))) as unknown as typeof fetch
    expect(await nameAgent('fix the login bug', { fetchFn: noModel })).toBeNull()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('still says so when a running Ollama fails', async () => {
    const error = quiet()
    const broken = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof fetch
    expect(await nameAgent('fix the login bug', { fetchFn: broken })).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('gives each example task a name a person can read, by rule alone', () => {
    const names = EXAMPLE_TASKS.map(nameFromPrompt)
    expect(names).toEqual(['Folder', 'Broken Outdated', 'Short Readme'])
  })
})
