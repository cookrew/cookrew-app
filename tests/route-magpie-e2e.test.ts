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
//   magpie serve · magpie provider add ollama · group/smart · group/think PINNED to one small
//   thinking model (`magpie group pick think ollama/qwen3:1.7b`) so the member is never a toss-up
//
// Three findings from the first real run are baked in here rather than hidden in the asserts,
// because each one is a product decision:
//   · claude 2.1.275 stalls on an unknown model id unless the enforcement is turned off — that
//     variable is now routeEnv's job, and this file ASSERTS it rather than supplying it
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
import { routeSession } from '../src/shared/route'
import type { TerminalNodeData } from '../src/shared/model'

const GATEWAY = 'http://127.0.0.1:3425'
const KEY = 'magpie-cookrew'
const OLLAMA = 'http://localhost:11434'
/** The group the brief names; claude can use it, codex cannot (see the header). */
const GROUP = 'group/smart'
/**
 * The group codex routes through, PINNED (routing=manual) to one small thinking model, so the
 * member the decision names is a constant and not whichever of two the router liked. The member
 * is asserted, not read: if the pin is gone the case says so instead of chasing a new model.
 */
const THINK_GROUP = 'group/think'
const THINK_MODEL = 'ollama/qwen3:1.7b'
const THINK_BARE = 'qwen3:1.7b'
const CLAUDE_BIN = 'claude'
const CODEX_BIN = 'codex'
const SPAWN_MS = 180_000
/**
 * Ollama holds one model at a time here, so a cold one is loaded BEFORE the case, not during it.
 * Each try is a preload and then a direct one-word turn, so the ceiling before the case stands
 * down is WARM_TRIES × 2 × WARM_MS = 270 s. A 1.4 GB model loads in about 3 s when the slot is
 * free; the rest of that budget is for a slot that is not.
 */
const PRELOAD_MS = 60_000
const WARM_TRIES = 3
const WARM_MS = 45_000

const hello = await fetch(`${GATEWAY}/api/hello`)
  .then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : null))
  .catch(() => null)
const RUN = process.env.COOKREW_MAGPIE_E2E === '1' && hello?.name === 'magpie'

// The key is not on RouteGateway any more (fix round 1: it never leaves main), so the spawn
// input is spelled out here the way the service spells it from the probe.
const gateway = { url: GATEWAY, v1: `${GATEWAY}/v1`, key: KEY }
const cards: string[] = []
const dirs: string[] = []
const latency: Record<string, number[]> = {}
const abstentions: string[] = []

/** Say out loud why a case is standing down, and keep the sentence for the report. */
function abstain(reason: string): void {
  abstentions.push(reason)
  process.stdout.write(`\n  ↯ ABSTAINED: ${reason}\n`)
}

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
    route: THINK_MODEL
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
  if (abstentions.length > 0) {
    writeFileSync('/tmp/route-abstentions.json', `${JSON.stringify(abstentions, null, 2)}\n`)
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
    // THE SPAWN ENV IS THE WHOLE ENV. Without this variable claude 2.1.275 sends the request,
    // gets its 200 and then stalls on its own unknown-model check — a routed card that looks
    // hung on its first turn. The test used to supply it; routeEnv does now, so it is asserted.
    expect(
      r.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT,
      'routeEnv must disable claude’s unknown-model wait, or every routed claude card hangs'
    ).toBe('1')
    const ran = await run(CLAUDE_BIN, ['-p', 'Reply with exactly the word OK'], r.env, workdir())
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
      r.env,
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

  it('routes codex through the pinned thinking group and files it the same way', async (ctx) => {
    // A LOCAL MODEL THAT CANNOT BE LOADED IS NOT A ROUTING FAULT, and this machine makes the
    // difference visible: Ollama holds ONE model at a time, and the fleet's turn-titler keeps
    // qwen2.5:1.5b resident with a rolling 5-minute keep-alive, so a request for any other model
    // waits for a slot that never frees (measured: 8 minutes, no load). The case therefore loads
    // the model itself first (keep_alive, so it survives the turn), retries a bounded number of
    // times, and ABSTAINS with the reason rather than reporting the route broken.
    const warm = await warmUp(THINK_MODEL)
    if (!warm.ok) {
      // vitest 2.1's `skip()` carries no reason, and a silent skip is the thing this whole file
      // exists to prevent — so the reason is said on stdout and left in a file beside the
      // latency numbers, and only then does the case abstain.
      abstain(
        `${THINK_MODEL} would not load: ${warm.attempts} attempts over ${Math.round(warm.ms / 1000)}s, ` +
          `Ollama is holding [${warm.resident.join(', ') || 'nothing'}]. ` +
          'Local-model capacity, not routing — report-e2e.md §8 has the one-line fix.'
      )
      ctx.skip()
      return
    }

    const id = card('e2e-codex')
    const session = routeSession(id)
    const r = routeEnv({ harness: 'codex', gateway, model: THINK_GROUP, cardId: id })
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
    expect(decision?.asked).toBe(THINK_GROUP)
    expect(decision?.group).toBe('think')
    // The pin, read back off the gateway: `magpie group pick think ollama/qwen3:1.7b`.
    expect(decision?.model, `${THINK_GROUP} is no longer pinned to ${THINK_MODEL}`).toBe(THINK_MODEL)

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
    expect(answered[0]?.model).toBe(THINK_BARE)
    expect(answered[0]?.out ?? 0).toBeGreaterThan(0)
  }, PRELOAD_MS + WARM_TRIES * WARM_MS + SPAWN_MS)

  it('spawns direct while the gateway is down, and routed again when it is back', async () => {
    const monitor = new GatewayMonitor({ hasBinary: () => true })
    const data = node(card('e2e-offline'), 'claude')
    const svc = service(monitor, data)

    expect((await monitor.refresh()).status).toBe('online')
    const online = svc.envFor(data)
    expect(online.effective).toBe(THINK_MODEL)
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
    expect(back.effective).toBe(THINK_MODEL)
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

/** What Ollama is holding right now — the evidence an abstention needs. */
async function resident(): Promise<string[]> {
  try {
    const body = (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
      r.json()
    )) as { models?: { name?: string }[] }
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Ollama's own preload: an EMPTY prompt loads the weights and answers nothing, and `keep_alive`
 * is the only way to say "hold it past this request" — a chat completion through the gateway
 * cannot carry it, so the model would be evictable again the moment it arrived.
 */
async function preload(model: string, keepAlive = '20m', timeoutMs = PRELOAD_MS): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.replace(/^ollama\//, ''), prompt: '', keep_alive: keepAlive }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch {
    return false
  }
}

/** One direct one-word turn: proof the weights are up, told apart from anything the route does. */
async function answersDirect(model: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.replace(/^ollama\//, ''),
        stream: false,
        messages: [{ role: 'user', content: 'say ok' }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch {
    return false
  }
}

interface Warm {
  ok: boolean
  attempts: number
  ms: number
  /** What Ollama held at the end — named in the skip so the reason is evidence, not a guess. */
  resident: string[]
}

/**
 * Load the model and prove it answers, in a BOUNDED number of tries. Unbounded waiting was the
 * first version's mistake: a single 90-second attempt on a machine whose one model slot is
 * taken reads exactly like a broken route.
 */
async function warmUp(model: string, tries = WARM_TRIES, perTryMs = WARM_MS): Promise<Warm> {
  const started = Date.now()
  for (let attempt = 1; attempt <= tries; attempt++) {
    await preload(model, '20m', perTryMs)
    if (await answersDirect(model, perTryMs)) {
      return { ok: true, attempts: attempt, ms: Date.now() - started, resident: await resident() }
    }
    await settle(1_000)
  }
  return { ok: false, attempts: tries, ms: Date.now() - started, resident: await resident() }
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
