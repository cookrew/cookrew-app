import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessHandlers, ACCESS_CHANNELS, registerAccessIpc } from '../src/main/access-ipc'
import { AccessStore, accessLaunch, fileKey, paneKeyName, probeEndpoint } from '../src/main/agent-access'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { macKeychain } from '../src/main/pane-keychain'
import { createSecretsStore } from '../src/main/secrets-store'
import { bootScript } from '../src/main/tmux-multiplexer'
import { bootCommand, envArgs } from '../src/main/herdr-host-multiplexer'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { ACCESS_ROWS, accessTools, checkEndpoint, simpleModeHelps, thirdPartyAnthropic, type AccessSource, type EndpointInput } from '../src/shared/agent-access'

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

  it('names the tools that speak each endpoint, the better one first', () => {
    expect(accessTools({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toEqual(['Claude Code', 'Pi'])
    expect(accessTools({ protocol: 'openai', wire: 'responses', baseUrl: 'https://a.example/v1' })).toEqual(['Codex', 'Pi'])
    expect(accessTools({ protocol: 'openai', wire: 'chat', baseUrl: 'https://a.example/v1' })).toEqual(['Pi'])
  })

  // Part C: Claude Code in full mode was refused by a third-party Anthropic-style
  // endpoint; simple mode and Pi both finished the task.
  it('puts Pi first on a third-party Anthropic-style endpoint', () => {
    expect(accessTools({ protocol: 'anthropic', baseUrl: 'https://llm.example.com' })).toEqual(['Pi', 'Claude Code'])
    expect(thirdPartyAnthropic('https://llm.example.com')).toBe(true)
    expect(thirdPartyAnthropic('https://api.anthropic.com')).toBe(false)
    expect(thirdPartyAnthropic('')).toBe(true)
  })

  it('puts Claude Code first when the person asked for its simple mode', () => {
    expect(accessTools({ protocol: 'anthropic', baseUrl: 'https://llm.example.com', simple: true })).toEqual(['Claude Code', 'Pi'])
  })

  it('carries the simple-mode choice through the form, and only a real true', () => {
    const good = { protocol: 'anthropic', baseUrl: 'https://llm.example.com', key: KEY, model: 'm' }
    expect(checkEndpoint({ ...good, simple: true })).toMatchObject({ value: { simple: true } })
    expect(checkEndpoint({ ...good, simple: 'yes' })).toMatchObject({ value: { simple: false } })
  })
})

describe('what an agent is launched with', () => {
  const paths = { readKey: fileKey('/keys/endpoint.key'), piDir: '/keys/pi' }

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

  it('turns on Claude Code’s simple mode only when asked, and for Claude Code only', () => {
    expect(accessLaunch(source, 'claude', paths)?.env.CLAUDE_CODE_SIMPLE).toBeUndefined()
    expect(accessLaunch({ ...source, simple: true }, 'claude', paths)?.env.CLAUDE_CODE_SIMPLE).toBe('1')
    expect(accessLaunch({ ...source, simple: true }, 'pi', paths)?.env.CLAUDE_CODE_SIMPLE).toBeUndefined()
  })

  it('reaches the pane: a real boot script hands it to the process', () => {
    const launch = accessLaunch({ ...source, simple: true }, 'claude', paths)
    const spec = { sessionName: 's', command: 'printenv CLAUDE_CODE_SIMPLE', shell: '/bin/sh', terminalId: 't', socketPath: '/s', cliDir: '/cli', path: '/usr/bin:/bin', cwd: tmpdir(), env: launch?.env, args: [] } as never
    expect(spawnSync('sh', ['-c', bootScript(spec)], { encoding: 'utf8' }).stdout.trim()).toBe('1')
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
    const launch = accessLaunch(source, 'claude', { readKey: fileKey("/Users/o'brien/a b/k"), piDir: '/p' })
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
    expect(store.state().active).toEqual({ id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', model: 'm-1', host: 'api.example.com', baseUrl: 'https://api.example.com', simple: false, tools: ['Pi', 'Claude Code'] })
    expect(JSON.stringify(store.state())).not.toContain(KEY)
  })

  it('writes the launch key 0600 in a private folder, one file per source and never one per card', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.launchFor('claude')
    store.launchFor('claude')
    const file = path.join(root, 'keys', `${paneKeyName(source)}.key`)
    expect(readFileSync(file, 'utf8')).toBe(KEY)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.join(root, 'keys'))).toEqual([`${paneKeyName(source)}.key`])
  })

  it('takes a new key at the next launch', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.save(source, 'another-fake-key')
    store.launchFor('claude')
    expect(readFileSync(path.join(root, 'keys', `${paneKeyName(source)}.key`), 'utf8')).toBe('another-fake-key')
  })

  it('is out of a served seat’s reach, like the sealed slots it copies', () => {
    const denied = ownerSecretPaths('/Users/owner/.cookrew', '/Users/owner')
    expect(denied).toEqual(expect.arrayContaining(['/Users/owner/.cookrew/secrets', '/Users/owner/.cookrew/access-keys', '/Users/owner/.cookrew/access.json']))
  })

  it('survives a relaunch, the simple-mode choice with it', () => {
    const root = dir()
    storeIn(root).save({ ...source, simple: true }, KEY)
    expect(storeIn(root).state().active?.model).toBe('m-1')
    expect(storeIn(root).active()?.simple).toBe(true)
  })

  it('launches nothing with no source, or a source whose key has gone', () => {
    expect(storeIn().launchFor('claude')).toBeNull()
    const root = dir()
    storeIn(root).save(source, KEY)
    const keeper = storeIn(root)
    keeper.launchFor('claude')
    createSecretsStore({ baseDir: root }).remove('agent-access-endpoint')
    expect(keeper.launchFor('claude')).toBeNull()
    expect(existsSync(path.join(root, 'keys', `${paneKeyName(source)}.key`))).toBe(false)
  })

  it('drops the copy whichever harness comes next, once the secret is gone', () => {
    const root = dir()
    const keeper = storeIn(root)
    keeper.save(source, KEY)
    keeper.launchFor('claude')
    createSecretsStore({ baseDir: root }).remove('agent-access-endpoint')
    expect(keeper.launchFor('codex')).toBeNull()
    expect(existsSync(path.join(root, 'keys', `${paneKeyName(source)}.key`))).toBe(false)
  })

  it('forgets all of it, launch files included', () => {
    const root = dir()
    const store = storeIn(root)
    store.save(source, KEY)
    store.launchFor('claude')
    const file = path.join(root, 'keys', `${paneKeyName(source)}.key`)
    expect(existsSync(file)).toBe(true)
    store.clear()
    expect(store.state().active).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(createSecretsStore({ baseDir: root }).read('agent-access-endpoint')).toBeNull()
  })
})

describe('the keychain, where there is one (N4)', () => {
  const fakeKeychain = (accepts = true) => {
    const items = new Map<string, string>()
    return {
      items,
      put: (name: string, value: string): boolean => (accepts ? (items.set(name, value), true) : false),
      remove: (name: string): void => void items.delete(name),
      reader: (name: string) => ({ command: '/usr/bin/security', args: ['find-generic-password', '-s', name, '-w'] })
    }
  }
  const storeWith = (root: string, keychain: ReturnType<typeof fakeKeychain> | null): AccessStore =>
    new AccessStore({ file: path.join(root, 'access.json'), keyDir: path.join(root, 'keys'), secrets: createSecretsStore({ baseDir: root }), keychain })
  const NAME = paneKeyName(source)
  const plainCopy = (root: string): string => path.join(root, 'keys', `${NAME}.key`)

  it('leaves no plain copy: the pane reads the key from the keychain, by name', () => {
    const root = dir()
    const keychain = fakeKeychain()
    const store = storeWith(root, keychain)
    store.save(source, KEY)
    const launch = store.launchFor('claude')
    expect(existsSync(plainCopy(root))).toBe(false)
    expect(keychain.items.get(NAME)).toBe(KEY)
    expect((JSON.parse(launch?.args[1] ?? '{}') as { apiKeyHelper: string }).apiKeyHelper).toBe(`/usr/bin/security find-generic-password -s ${NAME} -w`)
    expect(JSON.stringify(launch)).not.toContain(KEY)
  })

  it('says keychain, on a store that has one', () => {
    const store = storeWith(dir(), fakeKeychain())
    expect(store.state().keyStore).toBe('keychain')
    store.save(source, KEY)
    store.launchFor('pi')
    expect(store.state().keyStore).toBe('keychain')
  })

  it('takes away the plain copy an earlier build left', () => {
    const root = dir()
    const old = storeWith(root, null)
    old.save(source, KEY)
    old.launchFor('claude')
    expect(existsSync(plainCopy(root))).toBe(true)
    storeWith(root, fakeKeychain()).launchFor('claude')
    expect(existsSync(plainCopy(root))).toBe(false)
  })

  it('falls back to the private file when the keychain refuses, and then says file: no word promises more than happened', () => {
    const root = dir()
    const store = storeWith(root, fakeKeychain(false))
    store.save(source, KEY)
    const launch = store.launchFor('claude')
    expect(readFileSync(plainCopy(root), 'utf8')).toBe(KEY)
    expect((JSON.parse(launch?.args[1] ?? '{}') as { apiKeyHelper: string }).apiKeyHelper).toContain('/bin/cat')
    expect(store.state().keyStore).toBe('file')
  })

  it('says file where there is no keychain to use', () => {
    expect(storeWith(dir(), null).state().keyStore).toBe('file')
  })

  it('takes away the plain copy under the old one-name file too', () => {
    const root = dir()
    const store = storeWith(root, fakeKeychain())
    store.save(source, KEY)
    mkdirSync(path.join(root, 'keys'), { recursive: true })
    writeFileSync(path.join(root, 'keys', 'endpoint.key'), KEY)
    store.launchFor('claude')
    expect(existsSync(path.join(root, 'keys', 'endpoint.key'))).toBe(false)
  })

  it('forgets the item with the rest', () => {
    const keychain = fakeKeychain()
    const store = storeWith(dir(), keychain)
    store.save(source, KEY)
    store.launchFor('claude')
    store.clear()
    expect(keychain.items.size).toBe(0)
  })

  it('drops the item once the secret is gone, as it does the file', () => {
    const root = dir()
    const keychain = fakeKeychain()
    const store = storeWith(root, keychain)
    store.save(source, KEY)
    store.launchFor('claude')
    createSecretsStore({ baseDir: root }).remove('agent-access-endpoint')
    expect(store.launchFor('claude')).toBeNull()
    expect(keychain.items.size).toBe(0)
  })

  it('keeps a harness with no launch from touching the keychain', () => {
    const keychain = fakeKeychain()
    const store = storeWith(dir(), keychain)
    store.save(source, KEY)
    expect(store.launchFor('opencode')).toBeNull()
    expect(keychain.items.size).toBe(0)
  })

  it('is out of a served seat’s reach: on today’s rules a seat could read it, measured with a canary', () => {
    expect(ownerSecretPaths('/Users/owner/.cookrew', '/Users/owner')).toContain('/Users/owner/Library/Keychains')
  })
})

describe('the Mac’s keychain, as the security tool takes it', () => {
  const rig = (reads = KEY) => {
    const calls: { args: readonly string[]; input?: string }[] = []
    const keychain = macKeychain((args, input) => {
      calls.push({ args, input })
      if (args.includes('find-generic-password')) return `${reads}\n`
      return ''
    })
    return { keychain, calls }
  }

  it('hands the key over stdin as hex: never in an argument, where ps shows it', () => {
    const { keychain, calls } = rig()
    expect(keychain.put('agent-access-endpoint', KEY)).toBe(true)
    const write = calls[0]
    expect(write.args).toEqual(['-i'])
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(KEY)
    expect(write.input).toContain(Buffer.from(KEY).toString('hex'))
    expect(write.input).not.toContain(KEY)
    expect(write.input).toContain('-T /usr/bin/security')
  })

  it('counts it as kept only once the pane’s own read gives it back', () => {
    expect(rig('something else').keychain.put('agent-access-endpoint', KEY)).toBe(false)
  })

  it('reads a failed tool as not kept, and never throws', () => {
    const keychain = macKeychain(() => {
      throw new Error('keychain locked')
    })
    expect(keychain.put('agent-access-endpoint', KEY)).toBe(false)
    expect(() => keychain.remove('agent-access-endpoint')).not.toThrow()
  })

  it('reads with an absolute path, so a pane’s PATH cannot change what runs', () => {
    expect(rig().keychain.reader('agent-access-endpoint').command).toBe('/usr/bin/security')
  })

  it('is not the old secrets item: secrets-store migrates those away', () => {
    expect(rig().keychain.reader('agent-access-endpoint').args.join(' ')).not.toContain('cookrew-secret-')
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

describe('changing a saved endpoint (N3)', () => {
  const FORM = { protocol: 'anthropic', baseUrl: 'https://a.example', key: KEY, model: 'm' }
  const saved = async () => {
    const store = storeIn()
    const asked: EndpointInput[] = []
    const respawned: string[] = []
    const handlers = accessHandlers({
      store,
      probe: async (input) => ((asked.push(input)), { ok: true }),
      respawn: async (id) => ((respawned.push(id)), true)
    })
    await handlers.save(FORM)
    return { store, handlers, asked, respawned }
  }

  it('tells a screen what it needs to edit, and never the key', async () => {
    const { store } = await saved()
    expect(store.state().active).toMatchObject({ baseUrl: 'https://a.example', model: 'm', simple: false })
    expect(JSON.stringify(store.state())).not.toContain(KEY)
  })

  it('keeps the saved key when the field is left empty, and asks the endpoint with it', async () => {
    const { store, handlers, asked } = await saved()
    expect(await handlers.save({ ...FORM, key: '', model: 'm-2', simple: true })).toMatchObject({ ok: true })
    expect(asked.at(-1)).toMatchObject({ key: KEY, model: 'm-2' })
    expect(store.active()).toMatchObject({ model: 'm-2', simple: true })
    expect(store.savedKey()).toBe(KEY)
  })

  it('takes a new key when one is pasted', async () => {
    const { store, handlers } = await saved()
    await handlers.save({ ...FORM, key: 'another-key-456' })
    expect(store.savedKey()).toBe('another-key-456')
  })

  it('never sends the saved key to a new address: it was given for the old one', async () => {
    const { handlers, asked } = await saved()
    const answer = await handlers.save({ ...FORM, baseUrl: 'https://elsewhere.example', key: '' })
    expect(answer).toMatchObject({ ok: false, field: 'key' })
    expect(asked).toHaveLength(1)
  })

  it('names an empty Address on an edit, rather than asking for a key (N8)', async () => {
    const { handlers } = await saved()
    expect(await handlers.save({ ...FORM, baseUrl: '  ', key: '' })).toMatchObject({ ok: false, field: 'baseUrl' })
  })

  it('still asks for a key when nothing is saved', async () => {
    const handlers = accessHandlers({ store: storeIn(), probe: async () => ({ ok: true }) })
    expect(await handlers.save({ ...FORM, key: '' })).toMatchObject({ ok: false, field: 'key' })
  })

  it('turns simple mode on with no key typed and no probe, then restarts the card that needs it', async () => {
    const { store, handlers, asked, respawned } = await saved()
    const answer = await handlers.simple({ terminalId: 't1' })
    expect(answer).toMatchObject({ ok: true, restarted: true })
    expect(store.active()?.simple).toBe(true)
    expect(store.savedKey()).toBe(KEY)
    expect(asked).toHaveLength(1)
    expect(respawned).toEqual(['t1'])
  })

  it('says so when the card could not be restarted, with simple mode still saved', async () => {
    const store = storeIn()
    const handlers = accessHandlers({ store, probe: async () => ({ ok: true }), respawn: async () => false })
    await handlers.save(FORM)
    expect(await handlers.simple({ terminalId: 't1' })).toMatchObject({ ok: true, restarted: false })
    expect(store.active()?.simple).toBe(true)
  })

  it('has nothing to turn on with no endpoint, or a bad ask', async () => {
    const handlers = accessHandlers({ store: storeIn(), probe: async () => ({ ok: true }), respawn: async () => true })
    expect(await handlers.simple({ terminalId: 't1' })).toMatchObject({ ok: false })
    const { handlers: live } = await saved()
    expect(await live.simple({ terminalId: 7 })).toMatchObject({ ok: false })
  })
})

describe('a key goes only to the address it was given for, a running pane included', () => {
  // A pane's address is fixed when it starts, and it reads its key by name each time.
  // One name for every address sent key B to host A from a card still running on A.
  const fake = () => {
    const items = new Map<string, string>()
    return { items, put: (name: string, value: string): boolean => (items.set(name, value), true), remove: (name: string): void => void items.delete(name), reader: (name: string) => ({ command: '/usr/bin/security', args: ['-s', name] }) }
  }
  const moved = { ...source, baseUrl: 'https://elsewhere.example' }
  const inStore = (root: string, keychain: ReturnType<typeof fake> | null): AccessStore =>
    new AccessStore({ file: path.join(root, 'access.json'), keyDir: path.join(root, 'keys'), secrets: createSecretsStore({ baseDir: root }), keychain })

  it('names the copy by its address', () => {
    expect(paneKeyName(source)).not.toBe(paneKeyName(moved))
    expect(paneKeyName(source)).toBe(paneKeyName({ ...source, baseUrl: 'https://api.example.com/v2' }))
    expect(paneKeyName(source)).toMatch(/^[a-z0-9-]+$/)
  })

  it('in the keychain: the old pane finds nothing, and never the new key', () => {
    const keychain = fake()
    const store = inStore(dir(), keychain)
    store.save(source, KEY)
    store.launchFor('claude')
    store.save(moved, 'key-for-elsewhere')
    expect(keychain.items.has(paneKeyName(source))).toBe(false)
    store.launchFor('claude')
    expect(keychain.items.has(paneKeyName(source))).toBe(false)
    expect(keychain.items.get(paneKeyName(moved))).toBe('key-for-elsewhere')
  })

  it('in a file: the same', () => {
    const root = dir()
    const store = inStore(root, null)
    store.save(source, KEY)
    store.launchFor('claude')
    store.save(moved, 'key-for-elsewhere')
    store.launchFor('claude')
    expect(readdirSync(path.join(root, 'keys'))).toEqual([`${paneKeyName(moved)}.key`])
  })

  it('a new key for the same address takes the same place: it is the same host', () => {
    const keychain = fake()
    const store = inStore(dir(), keychain)
    store.save(source, KEY)
    store.launchFor('claude')
    store.save(source, 'rotated-key')
    store.launchFor('claude')
    expect(keychain.items.get(paneKeyName(source))).toBe('rotated-key')
  })

  it('tells a screen when running agents were left behind', async () => {
    const handlers = accessHandlers({ store: storeIn(), probe: async () => ({ ok: true }) })
    const FORM = { protocol: 'anthropic', baseUrl: 'https://a.example', key: KEY, model: 'm' }
    expect(await handlers.save(FORM)).toMatchObject({ ok: true, moved: false })
    expect(await handlers.save({ ...FORM, model: 'm-2' })).toMatchObject({ ok: true, moved: false })
    expect(await handlers.save({ ...FORM, baseUrl: 'https://b.example' })).toMatchObject({ ok: true, moved: true })
  })
})

describe('whether simple mode is the fix for a card (N3)', () => {
  const active = { id: 'endpoint', label: 'x', protocol: 'anthropic', model: 'm', host: 'a.example', baseUrl: 'https://a.example', simple: false, tools: ['Pi', 'Claude Code'] } as const

  it('is for Claude Code on a third-party Anthropic-style endpoint without it', () => {
    expect(simpleModeHelps('Claude Code', active)).toBe(true)
  })

  it('is not for another tool, simple mode already on, Anthropic itself, an OpenAI-style source, or no source', () => {
    expect(simpleModeHelps('Pi', active)).toBe(false)
    expect(simpleModeHelps('Claude Code', { ...active, simple: true })).toBe(false)
    expect(simpleModeHelps('Claude Code', { ...active, baseUrl: 'https://api.anthropic.com' })).toBe(false)
    expect(simpleModeHelps('Claude Code', { ...active, protocol: 'openai' })).toBe(false)
    expect(simpleModeHelps('Claude Code', null)).toBe(false)
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
    const store = storeIn()
    await accessHandlers({ store, probe: async () => ({ ok: true }) }).save({ protocol: 'anthropic', baseUrl: 'https://a.example', key: KEY, model: 'm', simple: true })
    expect(store.active()?.simple).toBe(true)
    expect(handlers.clear().active).toBeNull()
  })
})

describe('simple mode is only ever kept where the form shows it', () => {
  const FORM = { protocol: 'anthropic', key: KEY, model: 'm', simple: true }

  it('stays on a third-party address', () => {
    expect(checkEndpoint({ ...FORM, baseUrl: 'https://a.example' })).toMatchObject({ value: { simple: true } })
  })

  it('goes on Anthropic’s own address, or an OpenAI-style one, where the box is hidden', () => {
    expect(checkEndpoint({ ...FORM, baseUrl: 'https://api.anthropic.com' })).toMatchObject({ value: { simple: false } })
    expect(checkEndpoint({ ...FORM, protocol: 'openai', baseUrl: 'https://a.example/v1' })).toMatchObject({ value: { simple: false } })
  })
})

describe('an empty field is named (N8)', () => {
  const FORM = { protocol: 'anthropic', baseUrl: 'https://a.example', key: KEY, model: 'm' }

  it.each([
    ['baseUrl', 'Address'],
    ['key', 'Key'],
    ['model', 'Model']
  ] as const)('%s', (field, word) => {
    const check = checkEndpoint({ ...FORM, [field]: '   ' })
    expect(check).toMatchObject({ ok: false, field })
    if (!check.ok) expect(check.why).toMatch(new RegExp(`^${word} is empty`))
  })

  it('names the first of several, top to bottom', () => {
    expect(checkEndpoint({ ...FORM, baseUrl: '', model: '' })).toMatchObject({ field: 'baseUrl' })
  })

  it('reads a missing field as an empty one', () => {
    expect(checkEndpoint({ protocol: 'anthropic' })).toMatchObject({ ok: false, field: 'baseUrl' })
  })
})
