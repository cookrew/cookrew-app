// THE WHOLE ROUTE, AGAINST THE REAL MAGPIE — no fakes, no fixtures.
//
// Everything else in this program is tested against an injected fetch and a fake gateway, which
// proves the shapes agree with what we BELIEVE magpie answers. This file proves the belief: it
// spawns the real `claude` and `codex` binaries under the env `routeEnv()` composes, and reads
// the decision and the usage row back out of the running gateway at 127.0.0.1:3425.
//
// It is skipped unless COOKREW_MAGPIE_E2E=1 AND /api/hello answers, so a normal `npm test` on a
// machine with no magpie never sees it:
//
//   COOKREW_MAGPIE_E2E=1 npx vitest run tests/route-magpie-e2e.test.ts
//
// What it needs set up once (docs/route-program/report-e2e.md has the full recipe):
//   magpie serve · magpie provider add ollama · a group of THINKING models for codex
//
// Three findings from the first real run are baked in as constants here rather than hidden in
// the asserts, because each one is a product decision waiting to be made:
//   · claude 2.1.275 stalls on an unknown model id unless the enforcement is turned off
//   · codex needs --skip-git-repo-check outside a repo and a closed stdin
//   · codex always asks for thinking, so qwen2.5 refuses it — it needs a qwen3-class member
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { toDecision, toTurnFacts } from '../src/main/route/decisions'
import { RouteService } from '../src/main/route/service'
import { routeEnv } from '../src/main/route-env'
import { routeSession, type RouteGateway } from '../src/shared/route'
import type { TerminalNodeData } from '../src/shared/model'

const GATEWAY = 'http://127.0.0.1:3425'
const KEY = 'magpie-cookrew'
/** A model every harness here can hold a conversation on: codex asks for thinking. */
const THINKING_MODEL = 'ollama/qwen3:4b'
/** The group the brief names; claude can use it, codex cannot (see the header). */
const GROUP = 'group/smart'
const CLAUDE_BIN = 'claude'
const CODEX_BIN = 'codex'
const SPAWN_MS = 180_000

const hello = await fetch(`${GATEWAY}/api/hello`)
  .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : null))
  .catch(() => null)
const RUN = process.env.COOKREW_MAGPIE_E2E === '1' && hello?.name === 'magpie'

const gateway: Pick<RouteGateway, 'url' | 'v1' | 'key'> = { url: GATEWAY, v1: `${GATEWAY}/v1`, key: KEY }
const cards: string[] = []
const dirs: string[] = []
const latency: Record<string, number[]> = {}

function card(prefix: string): string {
  const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  cards.push(id)
  return id
}

function workdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'route-e2e-'))
  dirs.push(dir)
  return dir
}

interface Ran {
  out: string
  code: number | null
  /** Wall time to the first byte of stdout — the closest thing a spawn has to a first token. */
  firstByteMs: number | null
}

/** Spawn a harness under a composed env and collect what it said. */
function run(bin: string, args: string[], env: Record<string, string>, cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let firstByteMs: number | null = null
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const take = (chunk: Buffer): void => {
      if (firstByteMs === null && chunk.length > 0) firstByteMs = Date.now() - started
      out += chunk.toString()
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const kill = setTimeout(() => child.kill('SIGKILL'), SPAWN_MS - 5_000)
    child.on('close', (code) => {
      clearTimeout(kill)
      resolve({ out, code, firstByteMs })
    })
  })
}

const routeOf = (session: string): Promise<unknown> =>
  fetch(`${GATEWAY}/v1/magpie/route?session=${encodeURIComponent(session)}`).then((r) => r.json())

const usageOf = (session: string): Promise<unknown> =>
  fetch(
    `${GATEWAY}/v1/magpie/usage/requests?period=today&q=${encodeURIComponent(session)}&limit=5`
  ).then((r) => r.json())

/** The gateway files a row a moment after the stream ends; give it that moment. */
async function settle(ms = 2_000): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function node(id: string, command: string): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: id,
    position: { x: 0, y: 0 },
    size: { width: 640, height: 420 },
    preset: 'Claude Code',
    command,
    cwd: '/tmp',
    orch: false,
    role: null,
    route: THINKING_MODEL
  } as TerminalNodeData
}

/** A service with only the deps envFor() reaches, so the real decision function is under test. */
function service(monitor: GatewayMonitor, data: TerminalNodeData): RouteService {
  return new RouteService({
    monitor,
    fetch: (input, init) => fetch(input, init) as never,
    home: process.env.HOME ?? '',
    pathEnv: process.env.PATH,
    pluginDir: path.join(tmpdir(), 'route-e2e-plugin'),
    node: (id) => (id === data.id ? data : null),
    updateNode: () => undefined,
    isServed: () => false,
    harnessOf: (command) => (command.includes('codex') ? 'codex' : 'claude'),
    phaseOf: () => undefined,
    canRestoreExact: () => true,
    respawn: () => Promise.resolve(true),
    dockCommands: () => [],
    writeFile: () => undefined
  })
}

afterAll(() => {
  if (Object.keys(latency).length > 0) {
    writeFileSync('/tmp/route-latency.json', `${JSON.stringify(latency, null, 2)}\n`)
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!RUN)('the route, against the real Magpie gateway', () => {
  it('probes online and names the gateway', async () => {
    const monitor = new GatewayMonitor({ hasBinary: () => true })
    const probe = await monitor.refresh()
    expect(probe.status).toBe('online')
    expect(probe.gateway).not.toBeNull()
    expect(probe.gateway?.url).toBe(GATEWAY)
    expect(probe.gateway?.v1).toBe(`${GATEWAY}/v1`)
    expect(probe.gateway?.port).toBe(3425)
  })

  it('routes claude through the group and files it under cookrew with the card session', async () => {
    const id = card('e2e-claude')
    const session = routeSession(id)
    const r = routeEnv({ harness: 'claude', gateway, model: GROUP, cardId: id })
    const ran = await run(
      CLAUDE_BIN,
      ['-p', 'Reply with exactly the word OK'],
      // The enforcement variable is NOT in routeEnv yet; without it claude 2.1.275 sends the
      // request and then stalls on its own unknown-model check, so a routed card looks hung.
      { ...r.env, CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1' },
      workdir()
    )
    expect(ran.out.length).toBeGreaterThan(0)
    await settle()

    const decision = toDecision(id, await routeOf(session), Date.now())
    expect(decision).not.toBeNull()
    expect(decision?.session).toBe(session)
    expect(decision?.asked).toBe(GROUP)
    expect(decision?.group).toBe('smart')
    expect(decision?.model?.startsWith('ollama/')).toBe(true)
    expect(decision?.status).toBe('200')

    const body = (await usageOf(session)) as { rows?: { agent?: string; session?: string }[] }
    const row = body.rows?.[0]
    expect(row?.agent).toBe('cookrew')
    expect(row?.session).toBe(session)
    const facts = toTurnFacts(body, [session])
    expect(facts?.model?.length).toBeGreaterThan(0)
    expect(facts?.outputTokens ?? 0).toBeGreaterThan(0)
  }, SPAWN_MS)

  it('answers the decision long-poll before the reply lands', async () => {
    const id = card('e2e-poll')
    const session = routeSession(id)
    const r = routeEnv({ harness: 'claude', gateway, model: GROUP, cardId: id })
    let replied = false
    const spawned = run(
      CLAUDE_BIN,
      ['-p', 'Count slowly from one to twenty, one number per line.'],
      { ...r.env, CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1' },
      workdir()
    ).then((ran) => {
      replied = true
      return ran
    })
    // The long poll holds until routing has decided — which is before the vendor is asked, and
    // therefore before the agent has a reply. THE FIRST ANSWER CAN CARRY A NULL MODEL: magpie
    // publishes the route the moment the request arrives and fills the member in a seq later, so
    // a status bar that reads the first answer and prints "this turn → …" prints nothing. The UI
    // has to follow `after=<seq>` until `model` is set, which is what this does.
    const polled = (await fetch(
      `${GATEWAY}/v1/magpie/route?session=${encodeURIComponent(session)}&after=0&wait=60`
    ).then((r2) => r2.json())) as { seq?: number }
    const first = toDecision(id, polled, Date.now())
    expect(first).not.toBeNull()
    expect(replied).toBe(false)

    let seq = polled.seq ?? 0
    let model = first?.model ?? null
    for (let i = 0; i < 6 && model === null; i++) {
      const next = (await fetch(
        `${GATEWAY}/v1/magpie/route?session=${encodeURIComponent(session)}&after=${seq}&wait=20`
      ).then((r2) => r2.json())) as { seq?: number }
      seq = next.seq ?? seq
      model = toDecision(id, next, Date.now())?.model ?? null
    }
    expect(model?.startsWith('ollama/')).toBe(true)
    expect(replied).toBe(false)
    await spawned
  }, SPAWN_MS)

  it('routes codex on a thinking model and files it the same way', async () => {
    const id = card('e2e-codex')
    const session = routeSession(id)
    const r = routeEnv({ harness: 'codex', gateway, model: THINKING_MODEL, cardId: id })
    // A LOCAL MODEL THAT CANNOT ANSWER IS NOT A ROUTING FAULT. codex asks for thinking, so this
    // case needs qwen3-class weights, and on a loaded machine Ollama can take minutes to load
    // them — the first run of this test failed with a 169-second 499 while a DIRECT call for the
    // same model timed out too. Warm it first and say which it is.
    const warm = await warmUp(THINKING_MODEL)
    expect(
      warm,
      `${THINKING_MODEL} did not answer a one-word prompt in 90s — Ollama is loaded, not the route`
    ).toBe(true)

    const ran = await run(
      CODEX_BIN,
      // --skip-git-repo-check: the temp dir is not a repo. The prompt is last, as codex takes it.
      ['exec', '--skip-git-repo-check', ...r.args, 'Reply with exactly the word OK'],
      r.env,
      workdir()
    )
    // NOT /\bOK\b/ on the whole output: codex echoes the prompt, so that matches itself. The
    // reply comes after codex's own `codex` banner line.
    expect(ran.out.split(/^codex$/m).pop() ?? '').toMatch(/\bOK\b/)
    await settle()

    const decision = toDecision(id, await routeOf(session), Date.now())
    expect(decision?.model).toBe(THINKING_MODEL)

    // NOT `decision.status === '200'`: codex fires a follow-up call as it exits and cancels it,
    // so the session's LATEST route is a 499 (client closed) even though the turn was answered.
    // The turn is the row that carries tokens, so that is what is asserted.
    const body = (await usageOf(session)) as {
      rows?: { agent?: string; session?: string; status?: number; model?: string; out?: number }[]
    }
    const answered = (body.rows ?? []).filter((row) => row.status === 200)
    expect(answered.length).toBeGreaterThan(0)
    expect(answered[0]?.agent).toBe('cookrew')
    expect(answered[0]?.session).toBe(session)
    expect(answered[0]?.model).toBe('qwen3:4b')
    expect(answered[0]?.out ?? 0).toBeGreaterThan(0)
  }, SPAWN_MS)

  it('spawns direct while the gateway is down, and routed again when it is back', async () => {
    const monitor = new GatewayMonitor({ hasBinary: () => true })
    const data = node(card('e2e-offline'), 'claude')
    const svc = service(monitor, data)

    expect((await monitor.refresh()).status).toBe('online')
    const online = svc.envFor(data)
    expect(online.effective).toBe(THINKING_MODEL)
    expect(online.offline).toBe(false)
    expect(online.env.ANTHROPIC_BASE_URL).toBe(GATEWAY)

    await stopGateway()
    expect((await monitor.refresh()).status).toBe('offline')
    const down = svc.envFor(data)
    expect(down.effective).toBe('direct')
    expect(down.offline).toBe(true)
    expect(down.env).toEqual({})
    expect(down.args).toEqual([])

    await startGateway()
    expect((await monitor.refresh()).status).toBe('online')
    const back = svc.envFor(data)
    expect(back.effective).toBe(THINKING_MODEL)
    expect(back.offline).toBe(false)
  }, SPAWN_MS)

  it('measures first-byte latency direct against through the gateway', async () => {
    const body = (model: string): string =>
      JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: 'say ok' }]
      })
    const first = async (url: string, model: string, headers: Record<string, string>): Promise<number> => {
      const started = Date.now()
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: body(model)
      })
      const reader = res.body?.getReader()
      await reader?.read()
      await reader?.cancel()
      return Date.now() - started
    }
    latency.direct = []
    latency.magpie = []
    for (let i = 0; i < 3; i++) {
      latency.direct.push(await first('http://localhost:11434/v1/chat/completions', 'qwen2.5:1.5b', {}))
      latency.magpie.push(
        await first(`${GATEWAY}/v1/chat/completions`, 'ollama/qwen2.5:1.5b', {
          authorization: `Bearer ${KEY}`,
          'X-Magpie-Session': routeSession(card('e2e-latency'))
        })
      )
    }
    const p50 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    expect(latency.direct.every((ms) => ms > 0)).toBe(true)
    expect(latency.magpie.every((ms) => ms > 0)).toBe(true)
    // The gateway must not be the reason a turn feels slow: half a second of overhead on a
    // first token would be visible, and anything near that is a regression worth a look.
    expect(p50(latency.magpie) - p50(latency.direct)).toBeLessThan(500)
  }, SPAWN_MS)
})

/** Ask Ollama for the model directly, so a slow local model is told apart from a broken route. */
async function warmUp(model: string): Promise<boolean> {
  const bare = model.replace(/^ollama\//, '')
  const stop = AbortSignal.timeout(90_000)
  try {
    const res = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: bare, stream: false, messages: [{ role: 'user', content: 'say ok' }] }),
      signal: stop
    })
    return res.ok
  } catch {
    return false
  }
}

/** Stop the gateway the way a person would, and wait until the port stops answering. */
async function stopGateway(): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('pkill', ['-f', 'magpie serve'], { stdio: 'ignore' })
    child.on('close', () => resolve())
  })
  for (let i = 0; i < 40; i++) {
    const up = await fetch(`${GATEWAY}/api/hello`).then(() => true).catch(() => false)
    if (!up) return
    await settle(250)
  }
  throw new Error('the gateway would not stop')
}

/** Start it again, detached, and wait until it answers. */
async function startGateway(): Promise<void> {
  const bin = path.join(process.env.HOME ?? '', '.local', 'bin', 'magpie')
  spawn(bin, ['serve'], { cwd: tmpdir(), detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${GATEWAY}/api/hello`).then((r) => r.ok).catch(() => false)
    if (up) return
    await settle(500)
  }
  throw new Error('the gateway did not come back')
}
