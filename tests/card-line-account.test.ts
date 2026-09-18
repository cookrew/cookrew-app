import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { Accounts, loadAccount } from '../src/main/account-v2'
import { CallCredentialService } from '../src/main/call-credential'
import { ServedCallers } from '../src/main/served-callers'
import { gateCaller, handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'
import { admitWithAccount } from '../src/main/served-admission'
import { doorBearer, type DoorBearerPort } from '../src/main/door-bearer'
import { cardBearerAnswer, isCardBearerRequest } from '../src/main/card-bearer'
import type { ServedTemplate } from '../src/main/session-served'

/**
 * THE CARD'S OWN LINE IS THE ACCOUNT (v3-04c) — the whole chain, for real.
 *
 * V3-04 put the import walk on the account and V3-04b brought the transcript
 * reads and END onto it. The THIRD caller of a listed door is this one: the
 * script that runs in the placed card's PTY, as its own node process. It was
 * still doing the v1 challenge ceremony with a per-door key, so one door heard
 * two callers for one card — and at a paid door the seat bought on the web
 * could not admit the line at all, because a key-holder sub is not the person
 * a seat names.
 *
 * NOTHING IS STUBBED ON THE CHAIN. A real registry mints the call token from a
 * real seat; the real door verifies it against the registry's published key and
 * runs the real `gateCaller`; the real `orch-line.mjs` is SPAWNED as a child
 * process with its own HOME, and reaches the app exactly as it does in
 * production — by reading the port and the secret out of ~/.cookrew.
 *
 * THE DOOR AND THE APP SHARE ONE LISTENER here, which is not a shortcut: a
 * listed door is always reached through the app's loopback relay proxy, so
 * from the card's side they are one origin already.
 */

const PASSWORD = 'correct horse battery staple'
const OWNER = 'drej'
const TEAM = 'alpha'
const DOOR = `@${OWNER}/${TEAM}`
const SLOW = 60_000

const template: ServedTemplate = Object.freeze({
  serviceId: 'svc-alpha',
  templateId: 'alpha',
  slug: TEAM,
  access: 'paid' as const,
  priceUsd: '1.00'
})

let registryDir = ''
let doorDir = ''
let origin = ''
let site: Server
let plane: Server
let planeOrigin = ''
const bases: string[] = []

let issuer: CallCredentialService
/** Every sub the door admitted at its line, in order. The point of the test. */
let openedBy: string[] = []
/** Every path the door was asked for, so a ceremony cannot happen unnoticed. */
let doorPaths: string[] = []
/** The secret the card must hold to ask the app anything. */
const SECRET = 'a-secret-only-this-user-can-read'
/** Which account the app is signed in as — set per case before a card starts. */
let signedInAs: Accounts | null = null

function machine(name: string): { base: string; accounts: Accounts } {
  const base = mkdtempSync(path.join(tmpdir(), `v3-04c-${name}-`))
  bases.push(base)
  return { base, accounts: new Accounts({ base, origin, deviceName: name }) }
}

const sessionToken = (base: string): string => {
  const token = loadAccount(base)?.session?.token
  if (typeof token !== 'string' || token === '') throw new Error('that base holds no session')
  return token
}

const call = async (
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

/**
 * THE DOOR'S DEPS, as the owner's app assembles them.
 *
 * `hasOpenSession` is true for the ACCOUNT and nobody else. That is the state
 * the gate sheet leaves behind: it paid the 402 and opened the session as
 * `acct-<username>` before the card was placed, which is exactly why the card
 * must arrive as the same caller. A key-holder sub meets the 402 instead —
 * the bug this fixes, and the control case below.
 */
const doorDeps = (): ServedEndpointDeps => ({
  issuer,
  callers: new ServedCallers(),
  doorName: () => DOOR,
  v2Tokens: createV2CallTokenVerifier({ keys: v2KeysOverHttp(origin) }),
  admit: async () => ({ workspaceId: 'w', sessionId: 's', created: false }),
  hasOpenSession: (_serviceId, sub) => sub === 'acct-lin',
  endSession: () => false,
  grantBudget: { allowsNewSession: () => true },
  conductorFor: () => null,
  ask: async () => '',
  sessionForCaller: () => null,
  turns: { history: () => [] },
  traces: {
    index: async () => [],
    boundaryMarkers: async () => [],
    page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
  },
  settle: async () => 'ok',
  paymentTerms: () => ({ x402Version: 1, accepts: [] }),
  crewFace: (t) => ({
    name: 'COOKREW Alpha',
    serviceId: t.serviceId,
    slug: t.slug,
    address: `${planeOrigin}/${t.slug}`,
    version: 1,
    access: t.access,
    door: 'Pilot',
    agents: 2
  })
})

/**
 * ONE LISTENER PLAYING THE APP AND THE DOOR.
 *
 *   POST /bearer            the app's one route with authority (card-bearer.ts)
 *   /@drej/alpha/…          the listed door, reached as the relay proxy reaches it
 *   /alpha/…                the same door DIALLED, which is the unlisted walk
 */
function startPlane(): Promise<void> {
  const deps = doorDeps()
  /** The app's side: the same walk its transcript and END take. */
  const port: DoorBearerPort = {
    admit: (target, team) => {
      if (!signedInAs) throw new Error('no account on this Mac')
      return admitWithAccount(target, team, signedInAs)
    },
    withKey: () => Promise.reject(new Error('the app never signs in with a key for a listed door'))
  }

  plane = createServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://plane.local')
    if (isCardBearerRequest(method, url.pathname)) {
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => (raw += chunk))
      request.on('end', () => {
        void (async () => {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = null
          }
          const answer = await cardBearerAnswer(
            {
              secret: () => SECRET,
              bearer: (name) =>
                doorBearer(port, { origin: planeOrigin, slug: name }, name),
              account: () => signedInAs?.account()?.username ?? null
            },
            {
              method,
              path: url.pathname,
              ...(typeof request.headers.authorization === 'string'
                ? { authorization: request.headers.authorization }
                : {}),
              body: parsed
            }
          )
          response.writeHead(answer.status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(answer.body))
        })()
      })
      return
    }

    // Everything else is the door. Both spellings of its prefix reach it: the
    // published name (listed, through the proxy) and the bare slug (dialled).
    const segments = url.pathname.split('/').filter((part) => part.length > 0)
    const listed = segments[0]?.startsWith('@') === true
    const rest = `/${segments.slice(listed ? 2 : 1).join('/')}`
    doorPaths.push(rest)

    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      void (async () => {
        let parsed: unknown = null
        try {
          parsed = raw === '' ? null : JSON.parse(raw)
        } catch {
          parsed = null
        }
        const headers = request.headers as Record<string, string | undefined>
        if (rest === '/line') {
          // THE REAL LADDER. A caller with an open session is admitted; one
          // without meets the owner's 402 at session start, which is where a
          // card signing in as somebody else would stop for ever.
          const gate = await gateCaller(deps, template, headers)
          if (!gate.ok) {
            response.writeHead(gate.response.status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(gate.response.body))
            return
          }
          openedBy.push(gate.claims.sub)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('event: hello\ndata: {"cols":80,"rows":24}\n\n')
          return
        }
        const answer = await handleServedRoute(deps, template, method, rest, { headers, body: parsed })
        if (answer === null) {
          response.writeHead(404).end('{}')
          return
        }
        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...(answer.headers ?? {})
        })
        response.end(JSON.stringify(answer.body))
      })()
    })
  })
  return new Promise((settle) => {
    plane.listen(0, '127.0.0.1', () => {
      planeOrigin = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`
      settle()
    })
  })
}

/**
 * RUN THE REAL CARD, with its own HOME — `os.homedir()` reads $HOME, which is
 * how this test reaches the same file the app writes without touching the
 * developer's own.
 */
interface CardRun {
  out: string
  code: number | null
}
function runCard(args: string[], home: string, until: RegExp, ms = 20_000): Promise<CardRun> {
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'resources', 'orch-line.mjs'), ...args],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    const done = (code: number | null): void => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      settle({ out, code })
    }
    const timer = setTimeout(() => done(null), ms)
    const watch = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      if (until.test(out)) done(null)
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('exit', (code) => done(code))
  })
}

/** A HOME with the one file the app writes for the card. */
function cardHome(token: string | null): string {
  const home = mkdtempSync(path.join(tmpdir(), 'v3-04c-home-'))
  bases.push(home)
  mkdirSync(path.join(home, '.cookrew'), { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(home, '.cookrew', 'relay-proxy.json'),
    JSON.stringify({
      port: Number(new URL(planeOrigin).port),
      ...(token === null ? {} : { token })
    }),
    { mode: 0o600 }
  )
  return home
}

beforeAll(async () => {
  registryDir = mkdtempSync(path.join(tmpdir(), 'v3-04c-registry-'))
  doorDir = mkdtempSync(path.join(tmpdir(), 'v3-04c-door-'))
  issuer = new CallCredentialService({ base: doorDir })
  const doors = new DoorStore(registryDir, { allowPrivate: true })
  doors.register(OWNER, {
    handle: OWNER,
    door: 'Pilot',
    name: TEAM,
    title: 'COOKREW Alpha',
    agents: 3,
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    address: `https://cookrew.dev/@${OWNER}/${TEAM}`,
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe']
  })
  site = createRegistry({
    store: new RegistryStore(registryDir),
    log: new TransparencyLog(registryDir),
    identity: new IdentityService(registryDir),
    doors,
    stars: new StarStore(registryDir),
    origin: 'https://cookrew.dev',
    v2: createV2(registryDir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  await startPlane()
}, SLOW)

afterAll(async () => {
  await new Promise<void>((resolve) => {
    plane.closeAllConnections()
    plane.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    site.closeAllConnections()
    site.close(() => resolve())
  })
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(doorDir, { recursive: true, force: true })
  for (const base of bases) rmSync(base, { recursive: true, force: true })
})

describe('the placed card at a listed door', () => {
  it('opens on the seat bought elsewhere, as the account, with no second payment', async () => {
    const owner = machine('owner')
    expect(await owner.accounts.claim({ username: OWNER, password: PASSWORD })).toMatchObject({
      ok: true
    })
    const guest = machine('guest')
    expect(await guest.accounts.claim({ username: 'lin', password: PASSWORD })).toMatchObject({
      ok: true
    })

    // The purchase that happened somewhere else — the web, in step 7 — as the
    // door reports it to cookrew.dev.
    const settled = await call(
      'POST',
      `/v2/teams/${DOOR}/seats/settle`,
      { username: 'lin', by: 'stripe', receipt: 'stripe test receipt' },
      sessionToken(owner.base)
    )
    expect(settled.status).toBe(201)

    signedInAs = guest.accounts
    openedBy = []
    doorPaths = []
    const card = await runCard(['--door', DOOR, '--name', 'Alpha'], cardHome(SECRET), /signed in as/)

    // THE CARD IS THE ACCOUNT. Same sub the gate opened the session as, which
    // is what lets it in past a paid door's 402 with nothing paid twice.
    expect(openedBy).toEqual(['acct-lin'])
    expect(card.out).toContain('signed in as @lin')

    // AND IT NEVER PERFORMED THE CEREMONY. No challenge was asked for, and the
    // only assert carried the account's token.
    expect(doorPaths).not.toContain('/api/call/challenge')
    expect(doorPaths.filter((one) => one === '/api/call/assert')).toHaveLength(1)
    // It did not even read the door's face — that is the key walk's first step.
    expect(doorPaths).not.toContain('/crew')
  }, SLOW)

  it('a guest with NO seat is refused in the door’s own words, and does not fall back to a key', async () => {
    const stranger = machine('stranger')
    expect(await stranger.accounts.claim({ username: 'bo', password: PASSWORD })).toMatchObject({
      ok: true
    })
    signedInAs = stranger.accounts
    openedBy = []
    doorPaths = []
    const card = await runCard(['--door', DOOR], cardHome(SECRET), /did not admit|no seat|✕/)

    expect(openedBy).toEqual([])
    // The phase doorBearer named travels all the way to the card's own output.
    expect(card.out).toContain('did not admit this account')
    // THE BUG THAT MUST NOT COME BACK: no key ceremony as a fallback. A card
    // that quietly became somebody else is what produced two callers per card.
    expect(doorPaths).not.toContain('/api/call/challenge')
    expect(doorPaths).not.toContain('/api/call/assert')
  }, SLOW)

  it('says to sign in when this Mac has no account, rather than enrolling a key', async () => {
    signedInAs = null
    openedBy = []
    doorPaths = []
    // The app is running and has minted no secret: exactly what a Mac with no
    // account looks like to a card.
    const card = await runCard(['--door', DOOR], cardHome(null), /sign in to Cookrew/)
    expect(card.out).toContain('sign in to Cookrew on this Mac')
    expect(doorPaths).toEqual([])
  }, SLOW)
})

describe('the DIRECT walk is untouched', () => {
  it('an unlisted door is still met with this Mac’s own key', async () => {
    signedInAs = null
    openedBy = []
    doorPaths = []
    // No --door: a dialled address, which is what an unpublished team or a Mac
    // on this Wi-Fi is. Nothing is published, so there is nothing for
    // cookrew.dev to mint against and the key IS the identity.
    const home = cardHome(SECRET)
    // Waited past the sign-in, to the line's own answer: stopping at "signed
    // in" would leave what the door did about it untested.
    const card = await runCard(
      ['--origin', planeOrigin, '--slug', TEAM, '--sub', 'ana'],
      home,
      /charges per session|✕/
    )

    // The ceremony ran, in full, at the door.
    expect(doorPaths).toContain('/crew')
    expect(doorPaths).toContain('/api/call/challenge')
    expect(doorPaths).toContain('/api/call/assert')
    expect(card.out).toContain('signed in as ana')

    // AND THE BUG, SHOWN RATHER THAN DESCRIBED. This is the same paid door,
    // and the session the gate opened belongs to `acct-lin`. A key-holder is
    // a different caller, so it has no open session and meets the owner's 402
    // at session start — the line never opens for it. That is precisely what
    // the card did at a LISTED door until this fix, which is why a seat bought
    // on the web could not admit the card it paid for.
    expect(openedBy).toEqual([])
    expect(doorPaths).toContain('/line')
  }, SLOW)

  it('a card with no door name never asks the app for anything', async () => {
    // The proof that the two walks do not cross: the file carries a perfectly
    // good secret and the direct card has no use for it.
    signedInAs = null
    doorPaths = []
    await runCard(['--origin', planeOrigin, '--slug', TEAM, '--sub', 'ana'], cardHome(SECRET), /signed in as|✕/)
    expect(doorPaths).toContain('/api/call/challenge')
  }, SLOW)
})
