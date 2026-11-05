import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessHandlers, ACCESS_CHANNELS, registerAccessIpc } from '../src/main/access-ipc'
import { AccessStore, accessLaunch, probeEndpoint } from '../src/main/agent-access'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { createSecretsStore } from '../src/main/secrets-store'
import { bootScript } from '../src/main/tmux-multiplexer'
import { bootCommand, envArgs } from '../src/main/herdr-host-multiplexer'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { ACCESS_ROWS, accessTools, checkEndpoint, type AccessSource } from '../src/shared/agent-access'

/**
 * A PERSON WITH NO CLAUDE OR CODEX ACCOUNT HAS A ROAD: their own endpoint. The
 * shape was first proved against the real binaries (claude 2.1.316, codex 0.166)
 * and a loopback fake; these pin it. The key here is fake, the server is
 * loopback, and `loopback()` refuses anything else.
 */

const KEY = 'fake-endpoint-key-123'
const loopback = (url: string): string => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error(`refusing to send a key to ${url}`)
  return url
}

interface Seen { path: string; bearer: boolean; model: unknown }
const seen: Seen[] = []
let status = 200
/** Per path, over `status`: an endpoint can have one route and not the other. */
const statusOf: Record<string, number> = {}
let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', bearer: req.headers.authorization === `Bearer ${KEY}`, model: (JSON.parse(body || '{}') as { model?: unknown }).model })
      res.writeHead(statusOf[req.url ?? ''] ?? status, { 'content-type': 'application/json' })
      res.end(`{"echo":"${req.headers.authorization}"}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = loopback(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
})
afterAll(() => server.close())

const dir = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-access-'))
const storeIn = (root = dir()): AccessStore =>
  new AccessStore({ file: path.join(root, 'access.json'), keyDir: path.join(root, 'keys'), secrets: createSecretsStore({ baseDir: root }) })
const source: AccessSource = { id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', baseUrl: 'https://api.example.com', model: 'm-1' }

describe('what a person types', () => {
  const good = { protocol: 'anthropic', baseUrl: 'https://api.example.com/', key: KEY, model: 'claude-x' }

  it('takes a plain https endpoint, and normalises the address the harness will extend', () => {
    expect(checkEndpoint(good)).toMatchObject({ ok: true, value: { baseUrl: 'https://api.example.com' } })
    expect(checkEndpoint({ ...good, baseUrl: 'https://api.example.com/v1' })).toMatchObject({ value: { baseUrl: 'https://api.example.com' } })
    expect(checkEndpoint({ ...good, protocol: 'openai', baseUrl: 'https://api.example.com/v1/' })).toMatchObject({ value: { baseUrl: 'https://api.example.com/v1' } })
  })

  it('takes http for this computer only: a key must not cross a network in the clear', () => {
    expect(checkEndpoint({ ...good, baseUrl: 'http://127.0.0.1:8000' }).ok).toBe(true)
    expect(checkEndpoint({ ...good, baseUrl: 'http://localhost:8000' }).ok).toBe(true)
    expect(checkEndpoint({ ...good, baseUrl: 'http://api.example.com' })).toMatchObject({ ok: false, field: 'baseUrl' })
  })

  it('refuses what cannot be an endpoint, naming the field', () => {
    expect(checkEndpoint({ ...good, baseUrl: 'not a url' })).toMatchObject({ ok: false, field: 'baseUrl' })
    expect(checkEndpoint({ ...good, baseUrl: 'ftp://a.example' })).toMatchObject({ ok: false, field: 'baseUrl' })
    expect(checkEndpoint({ ...good, baseUrl: 'https://user:pw@a.example' })).toMatchObject({ ok: false, field: 'baseUrl' })
    expect(checkEndpoint({ ...good, baseUrl: 'https://a.example/?x=1' })).toMatchObject({ ok: false, field: 'baseUrl' })
    expect(checkEndpoint({ ...good, key: '' })).toMatchObject({ ok: false, field: 'key' })
    expect(checkEndpoint({ ...good, key: 'two words' })).toMatchObject({ ok: false, field: 'key' })
    expect(checkEndpoint({ ...good, model: "m'; rm -rf ~" })).toMatchObject({ ok: false, field: 'model' })
    expect(checkEndpoint({ ...good, protocol: 'gopher' })).toMatchObject({ ok: false, field: 'protocol' })
    expect(checkEndpoint(null)).toMatchObject({ ok: false })
  })

  it('names the tools that speak each endpoint', () => {
    expect(accessTools({ protocol: 'anthropic' })).toEqual(['Claude Code', 'Pi'])
    expect(accessTools({ protocol: 'openai', wire: 'responses' })).toEqual(['Codex', 'Pi'])
    expect(accessTools({ protocol: 'openai', wire: 'chat' })).toEqual(['Pi'])
  })
})

describe('what an agent is launched with', () => {
  const paths = { keyFile: '/keys/endpoint.key', piDir: '/keys/pi' }

  it('points Claude Code at the endpoint, its key behind a helper', () => {
    const launch = accessLaunch(source, 'claude', paths)
    expect(launch?.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_MODEL: 'm-1' })
    expect(launch?.args[0]).toBe('--settings')
    expect(JSON.parse(launch?.args[1] ?? '{}')).toEqual({ apiKeyHelper: '/bin/cat /keys/endpoint.key' })
  })

  it('points Codex at it through a provider of its own, on the Responses API it requires', () => {
    const launch = accessLaunch({ ...source, protocol: 'openai', baseUrl: 'https://api.example.com/v1', wire: 'responses' }, 'codex', paths)
    expect(launch?.args).toEqual(expect.arrayContaining(['model_provider=cookrew', 'model_providers.cookrew.base_url=https://api.example.com/v1', 'model_providers.cookrew.auth={command="/bin/cat",args=["/keys/endpoint.key"]}', 'model_providers.cookrew.wire_api=responses', 'model=m-1']))
  })

  it('leaves Codex out of an endpoint with no Responses API: it refuses chat', () => {
    expect(accessLaunch({ ...source, protocol: 'openai', wire: 'chat' }, 'codex', paths)).toBeNull()
  })

  it('points Pi at either protocol, in a folder of its own, chat-only endpoints included', () => {
    const anthropic = accessLaunch(source, 'pi', paths)
    expect(anthropic?.env.PI_CODING_AGENT_DIR).toBe('/keys/pi')
    expect(anthropic?.args).toEqual(['--provider', 'cookrew', '--model', 'm-1'])
    const models = JSON.parse(anthropic?.files[0].content ?? '{}') as { providers: { cookrew: Record<string, unknown> } }
    expect(models.providers.cookrew).toMatchObject({ api: 'anthropic-messages', baseUrl: 'https://api.example.com', apiKey: '!/bin/cat /keys/endpoint.key', models: [{ id: 'm-1' }] })
    const chat = accessLaunch({ ...source, protocol: 'openai', baseUrl: 'https://a.example/v1', wire: 'chat' }, 'pi', paths)
    expect(chat?.files[0].content).toContain('openai-completions')
  })

  it('leaves a harness that does not speak the protocol alone', () => {
    expect(accessLaunch(source, 'codex', paths)).toBeNull()
    expect(accessLaunch({ ...source, protocol: 'openai' }, 'claude', paths)).toBeNull()
    expect(accessLaunch(source, 'opencode', paths)).toBeNull()
  })

  it('takes a hosted source with no change: credits are one more source and one more row', () => {
    const credits: AccessSource = { id: 'credits', label: 'Cookrew credits', protocol: 'anthropic', baseUrl: 'https://credits.example.com', model: 'auto' }
    expect(accessLaunch(credits, 'claude', paths)?.env.ANTHROPIC_BASE_URL).toBe('https://credits.example.com')
    expect(ACCESS_ROWS.map((row) => row.id)).toEqual(['endpoint'])
  })
})

describe('the key is in no command line and in no process’s environment', () => {
  // A served seat's sandbox cannot stop it reading another process's environment:
  // measured 2026-11-05 on Darwin 25.5, KERN_PROCARGS2 returned a canary from
  // inside the seat profile, and no Seatbelt rule tried stopped it. So the key is
  // never there. It stays in a file the seat is denied, and each harness reads it.
  const awkward = 'fake$key`with"marks\''
  const launched = (harness: 'claude' | 'codex' | 'pi') => {
    const root = dir()
    const store = storeIn(root)
    store.save({ ...source, protocol: harness === 'codex' ? 'openai' : 'anthropic', wire: harness === 'codex' ? 'responses' : undefined }, awkward)
    return { root, launch: store.launchFor(harness) }
  }

  it.each(['claude', 'codex', 'pi'] as const)('%s: not in its env, its args, or the boot script', (harness) => {
    const { launch, root } = launched(harness)
    const spec = { sessionName: 's', command: 'printenv', shell: '/bin/sh', terminalId: 't', socketPath: '/s', cliDir: '/cli', path: '/usr/bin:/bin', cwd: root, env: launch?.env, args: launch?.args } as never
    for (const line of [JSON.stringify(launch?.env), JSON.stringify(launch?.args), bootScript(spec), bootCommand(spec), envArgs(spec).join(' ')]) expect(line).not.toContain('fake$key')
    expect(JSON.stringify(new DirectMultiplexer().attachSpawn(spec))).not.toContain('fake$key')
    expect(spawnSync('sh', ['-c', bootScript({ ...(spec as object), args: [] } as never)], { encoding: 'utf8' }).stdout).not.toContain('fake$key')
  })

  it('Claude’s helper hands back the key exactly, shell characters and all', () => {
    const { launch } = launched('claude')
    const helper = (JSON.parse(launch?.args[1] ?? '{}') as { apiKeyHelper: string }).apiKeyHelper
    expect(spawnSync('sh', ['-c', helper], { encoding: 'utf8' }).stdout).toBe(awkward)
  })

  it('Pi’s file names the command, not the key', () => {
    const { launch } = launched('pi')
    expect(launch?.files[0].content).not.toContain('fake$key')
  })

  it('a folder with a space in it is quoted for the shell', () => {
    const launch = accessLaunch(source, 'claude', { keyFile: "/Users/o'brien/a b/k", piDir: '/p' })
    expect((JSON.parse(launch?.args[1] ?? '{}') as { apiKeyHelper: string }).apiKeyHelper).toBe(`/bin/cat '/Users/o'\\''brien/a b/k'`)
  })
})

describe('where it is kept', () => {
  it('seals the key in the secrets store and keeps only the rest beside it', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    expect(readFileSync(path.join(root, 'access.json'), 'utf8')).not.toContain(KEY)
    expect(createSecretsStore({ baseDir: root }).read('agent-access-endpoint')?.value).toBe(KEY)
  })

  it('tells the screens everything but the key', () => {
    const store = storeIn()
    store.save(source, KEY)
    expect(store.state().active).toEqual({ id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', model: 'm-1', host: 'api.example.com', tools: ['Claude Code', 'Pi'] })
    expect(JSON.stringify(store.state())).not.toContain(KEY)
  })

  it('writes the launch key 0600 in a private folder, one file per source and never one per card', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.launchFor('claude')
    store.launchFor('claude')
    const file = path.join(root, 'keys', 'endpoint.key')
    expect(readFileSync(file, 'utf8')).toBe(KEY)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.join(root, 'keys'))).toEqual(['endpoint.key'])
  })

  it('takes a new key at the next launch', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.save(source, 'another-fake-key')
    store.launchFor('claude')
    expect(readFileSync(path.join(root, 'keys', 'endpoint.key'), 'utf8')).toBe('another-fake-key')
  })

  it('is out of a served seat’s reach, like the sealed slots it copies', () => {
    const denied = ownerSecretPaths('/Users/owner/.cookrew', '/Users/owner')
    expect(denied).toEqual(expect.arrayContaining(['/Users/owner/.cookrew/secrets', '/Users/owner/.cookrew/access-keys', '/Users/owner/.cookrew/access.json']))
  })

  it('survives a relaunch', () => {
    const root = dir()
    storeIn(root).save(source, KEY)
    expect(storeIn(root).state().active?.model).toBe('m-1')
  })

  it('launches nothing with no source, or a source whose key has gone', () => {
    expect(storeIn().launchFor('claude')).toBeNull()
    const root = dir()
    storeIn(root).save(source, KEY)
    const keeper = storeIn(root)
    keeper.launchFor('claude')
    createSecretsStore({ baseDir: root }).remove('agent-access-endpoint')
    expect(keeper.launchFor('claude')).toBeNull()
    expect(existsSync(path.join(root, 'keys', 'endpoint.key'))).toBe(false)
  })

  it('drops the copy whichever harness comes next, once the secret is gone', () => {
    const root = dir()
    const keeper = storeIn(root)
    keeper.save(source, KEY)
    keeper.launchFor('claude')
    createSecretsStore({ baseDir: root }).remove('agent-access-endpoint')
    expect(keeper.launchFor('codex')).toBeNull()
    expect(existsSync(path.join(root, 'keys', 'endpoint.key'))).toBe(false)
  })

  it('forgets all of it, launch files included', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.launchFor('claude')
    const file = path.join(root, 'keys', 'endpoint.key')
    expect(existsSync(file)).toBe(true)
    store.clear()
    expect(store.state().active).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(createSecretsStore({ baseDir: root }).read('agent-access-endpoint')).toBeNull()
  })
})

describe('asking the endpoint, against a fake on loopback', () => {
  const anthropic = () => ({ protocol: 'anthropic' as const, baseUrl: loopback(base), key: KEY, model: 'fake-model' })
  const openai = () => ({ protocol: 'openai' as const, baseUrl: loopback(`${base}/v1`), key: KEY, model: 'fake-model' })

  it('calls the paths the harnesses call, with their bearer', async () => {
    seen.length = 0
    status = 200
    expect(await probeEndpoint(anthropic())).toEqual({ ok: true })
    expect(await probeEndpoint(openai())).toEqual({ ok: true, wire: 'responses' })
    expect(seen).toEqual([{ path: '/v1/messages', bearer: true, model: 'fake-model' }, { path: '/v1/responses', bearer: true, model: 'fake-model' }])
  })

  it('names a refused key, and never repeats what the server said', async () => {
    status = 401
    const answer = await probeEndpoint(anthropic())
    expect(answer).toMatchObject({ ok: false, field: 'key' })
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  it('falls back to chat completions: most OpenAI-compatible servers have no Responses API, and Pi needs none', async () => {
    status = 200
    statusOf['/v1/responses'] = 404
    expect(await probeEndpoint(openai())).toEqual({ ok: true, wire: 'chat' })
    delete statusOf['/v1/responses']
  })

  it('says so when neither is there', async () => {
    status = 404
    expect(await probeEndpoint(openai())).toMatchObject({ ok: false, field: 'baseUrl', why: expect.stringMatching(/usually ending in \/v1/) })
  })

  it('counts a rate limit or a picky request as an answer: the door is there', async () => {
    status = 429
    expect(await probeEndpoint(anthropic())).toEqual({ ok: true })
    status = 400
    expect(await probeEndpoint(anthropic())).toEqual({ ok: true })
  })

  it('says when nothing is there', async () => {
    expect(await probeEndpoint({ ...anthropic(), baseUrl: loopback('http://127.0.0.1:9') })).toMatchObject({ ok: false, field: 'baseUrl' })
  })
})

describe('the bridge', () => {
  it('registers exactly the channel table', () => {
    const registered: string[] = []
    registerAccessIpc({ handle: (channel: string) => void registered.push(channel) }, { store: storeIn(), probe: async () => ({ ok: true }) })
    expect(registered).toEqual([...ACCESS_CHANNELS])
  })

  it('saves only what the endpoint accepted', async () => {
    const store = storeIn()
    const handlers = accessHandlers({ store, probe: async () => ({ ok: false, field: 'key', why: 'refused' }) })
    expect(await handlers.save({ protocol: 'anthropic', baseUrl: 'https://a.example', key: KEY, model: 'm' })).toMatchObject({ ok: false, field: 'key' })
    expect(store.state().active).toBeNull()
  })

  it('refuses a bad form before asking anyone', async () => {
    let asked = false
    const handlers = accessHandlers({ store: storeIn(), probe: async () => ((asked = true), { ok: true }) })
    expect(await handlers.save({ protocol: 'anthropic', baseUrl: 'http://a.example', key: KEY, model: 'm' })).toMatchObject({ ok: false })
    expect(asked).toBe(false)
  })

  it('answers the new state, and clears', async () => {
    const handlers = accessHandlers({ store: storeIn(), probe: async () => ({ ok: true }) })
    expect(await handlers.save({ protocol: 'openai', baseUrl: 'https://a.example/v1', key: KEY, model: 'm' })).toMatchObject({ ok: true, state: { active: { protocol: 'openai' } } })
    expect(handlers.clear().active).toBeNull()
  })
})
