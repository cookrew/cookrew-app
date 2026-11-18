// A REAL RUN OF cookrew-seal/2 THROUGH THE REGISTRY, WITH THE WIRE CAPTURED.
//
// The unmodified registry runs as its own process (registry.ts). Every TCP
// connection to it goes through a tee on loopback that keeps every byte both
// ways: the Mac's held line, every caller request and answer. The Mac's end
// is the app's own code (canvas link, bridge, terminus, the line's dialer);
// the callers are the page's and main's own carriers. Then the capture is
// searched for every canary, raw and inside every base64 run, and a request
// sent in the clear on purpose shows the search finds what is there.
//
//   npx vite-node scripts/seal-v2-capture/run.ts [out dir]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvasBridge, loopbackDialer, RELAY_MARKER } from '../../src/main/canvas-bridge'
import { createCanvasLink } from '../../src/main/canvas-link'
import { createSealTerminus, isSealPath, routeSeal, type SealTerminus } from '../../src/main/canvas-seal-terminus'
import { createSealMarks, SEALED_ONLY_ERROR } from '../../src/main/seal-marks'
import { createSealPeers } from '../../src/main/seal-peers'
import { cameOverRelayLine, relayLineHeaders, sealProofHeaders } from '../../src/main/seal-proof'
import { takeRelayDevice } from '../../src/main/relay-device'
import { connectCodeId, newConnectCode } from '../../src/shared/canvas-seal'
import { machineRelayPath, RELAY_SESSION_HEADER } from '../../src/shared/machine-relay'
import { startCodeHandshake } from '../../src/shared/seal2/handshake'
import { readBody, sealedFetch } from '../../src/shared/seal2/http'
import { runSeal2Link, Seal2RefusedError, shakeHandsOverHttp } from '../../src/shared/seal2/http-link'
import type { Seal2Session } from '../../src/shared/seal2/records'
import { startHandshake } from '../../src/shared/canvas-seal'
import { createInbox, createRecordReader, decodeFrame, encodeFrame, encodeRecord, type SealFrame } from '../../src/shared/canvas-seal-wire'
import { newDevice, signUp, verifyDevice } from '../../tests/support/seal2-accounts'

const until = async (what: () => boolean, why: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** An old phone: canvas-seal v1 exactly as the pages before v2 speak it. One GET, its answer as text. */
async function oldPhoneGet(prefix: string, code: Uint8Array, headers: Record<string, string>, route: string, auth: string): Promise<string> {
  const started = await startHandshake(code)
  const hello = await fetch(`${prefix}/~seal/hello`, { method: 'POST', headers, body: JSON.stringify(started.hello) })
  const answer = (await hello.json()) as { session: string; accept: { e: string; proof: string } }
  const done = await started.finish(answer.accept)
  if (done === null) throw new Error('v1: no proof')
  await fetch(`${prefix}/~seal/finish`, { method: 'POST', headers, body: JSON.stringify({ session: answer.session, ...done.finish }) })
  const frames: SealFrame[] = []
  const inbox = createInbox(done.session, (plain) => {
    const frame = decodeFrame(plain)
    if (frame) frames.push(frame)
  })
  const stop = new AbortController()
  const down = await fetch(`${prefix}/~seal/down?s=${done.session.id}&from=0`, { headers, signal: stop.signal })
  const reader = createRecordReader()
  void (async () => {
    try {
      for await (const chunk of down.body as unknown as AsyncIterable<Uint8Array>) for (const record of reader.push(chunk)) await inbox.accept(record)
    } catch {
      // hung up
    }
  })()
  const records = [await done.session.seal(encodeFrame({ kind: 'open', stream: 1, method: 'GET', path: route, headers: { authorization: auth } })), await done.session.seal(encodeFrame({ kind: 'end', stream: 1 }))]
  await fetch(`${prefix}/~seal/up?s=${done.session.id}`, { method: 'POST', headers, body: Buffer.concat(records.map(encodeRecord)) })
  await until(() => frames.some((frame) => frame.kind === 'end' && frame.stream === 1), 'the v1 answer', 8000)
  stop.abort()
  return Buffer.concat(frames.flatMap((frame) => (frame.kind === 'data' ? [Buffer.from(frame.data)] : []))).toString()
}

const CANARY = {
  pairingToken: 'Bearer canary-pairing-token-a1b2c3',
  machineKey: 'Bearer canary-machine-key-d4e5f6',
  route: '/api/canary-route-0f9e8d',
  prompt: 'canary-typed-prompt-7a6b5c',
  password: 'canary-mac-password-5d4c3b',
  reply: 'canary-transcript-reply-3c2d1e',
  event: 'canary-event-9a8b7c',
  v1Route: '/api/canary-v1-route-112233',
  deviceRoute: '/api/canary-device-route-998877'
}
const CONTROL = { token: 'Bearer control-plain-token-aabbcc', route: '/api/control-plain-route-445566', body: 'control-plain-body-778899' }

const root = fileURLToPath(new URL('../..', import.meta.url))
const out = process.argv[2] ?? path.join(tmpdir(), `seal2-capture-${Date.now()}`)
mkdirSync(out, { recursive: true })

interface Chunk {
  readonly conn: number
  readonly dir: 'to-registry' | 'from-registry'
  readonly bytes: Buffer
}
const chunks: Chunk[] = []

const listen = (server: Server | ReturnType<typeof createTcpServer>): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

async function startRegistry(dir: string): Promise<{ port: number; stop(): void }> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(path.join(root, 'node_modules/.bin/vite-node'), [path.join(root, 'scripts/seal-v2-capture/registry.ts'), String(port), dir], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => (String(data).includes('listening') ? resolve() : undefined))
    child.on('exit', (code) => reject(new Error(`registry exited ${code}`)))
  })
  return { port, stop: () => child.kill('SIGTERM') }
}

/** Every byte between anyone and the registry, both ways. */
async function startTee(registryPort: number): Promise<{ port: number; close(): void }> {
  let next = 0
  const server = createTcpServer((client) => {
    const conn = (next += 1)
    const upstream = connect(registryPort, '127.0.0.1')
    client.on('data', (bytes: Buffer) => chunks.push({ conn, dir: 'to-registry', bytes: Buffer.from(bytes) }))
    upstream.on('data', (bytes: Buffer) => chunks.push({ conn, dir: 'from-registry', bytes: Buffer.from(bytes) }))
    client.pipe(upstream)
    upstream.pipe(client)
    const end = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', end)
    upstream.on('error', end)
    client.on('close', end)
    upstream.on('close', end)
  })
  const port = await listen(server)
  return { port, close: () => server.close() }
}

let events: ((chunk: string) => void) | null = null
const reached: string[] = []

function companion(terminus: () => SealTerminus | undefined, marks: ReturnType<typeof createSealMarks>): Server {
  return createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const device = takeRelayDevice(request)
    if (cameOverRelayLine(request) && marks.refuses(device?.deviceId ?? null)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: SEALED_ONLY_ERROR }))
      return
    }
    reached.push(`${request.method} ${url.pathname} relayed=${request.headers[RELAY_MARKER]} auth=${request.headers.authorization ? 'yes' : 'no'}`)
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': open\n\n')
      events = (chunk) => response.write(chunk)
      return
    }
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(url.pathname === CONTROL.route ? `${CONTROL.body}-echo` : CANARY.reply)
    })
  })
}

/** Base64 and base64url runs, decoded: the registry's line frames carry bodies so. */
const decodedRuns = (text: string): string =>
  (text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [])
    .map((run) => {
      try {
        return Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1')
      } catch {
        return ''
      }
    })
    .join('\n')

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal2-capture-registry-'))
  const registry = await startRegistry(dir)
  const tee = await startTee(registry.port)
  const origin = `http://127.0.0.1:${tee.port}`
  const mac = newDevice()
  const other = newDevice()
  const accounts = await signUp({ origin }, mac, other)
  const phoneSession = { [RELAY_SESSION_HEADER]: accounts.phoneSession }
  const otherSession = { [RELAY_SESSION_HEADER]: accounts.otherSession }
  const signUpEnds = chunks.length

  const code = newConnectCode()
  const codeId = await connectCodeId(code)
  const marks = createSealMarks(path.join(dir, 'seal-marks.json'))
  let terminus: SealTerminus | undefined
  const macServer = companion(() => terminus, marks)
  const macPort = await listen(macServer)
  terminus = createSealTerminus({
    codeFor: (asked) => (asked === codeId ? code : null),
    dial: loopbackDialer(macPort, undefined, sealProofHeaders()),
    device: { self: () => mac.signer, verify: verifyDevice, trusted: async (id) => id === other.id },
    onSealed: ({ peer, outer }) => {
      if (peer.mode === 'code' && outer.device !== undefined) marks.mark(outer.device)
    }
  })
  const link = createCanvasLink({ origin: () => origin, credential: () => ({ token: accounts.desktopToken, deviceId: mac.id }) })
  const bridge = createCanvasBridge({ send: (line) => link.send(line), dial: loopbackDialer(macPort, undefined, relayLineHeaders()) })
  link.onFrame((line) => bridge.frame(line))
  link.onDrop(bridge.reset)
  link.start()
  await until(() => link.held(), 'the Mac line', 8000)
  const prefix = `${origin}/api/m/${mac.id}`
  const withSession = (session: Record<string, string>): typeof fetch => (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...session } })
  const results: Record<string, string> = {}

  // 1. A phone on v2: the unlock-shaped POST (a password inside), and an event stream.
  const phoneHttp = { url: (route: string) => `${prefix}${route}`, fetchFn: withSession(phoneSession), retryMs: 100 }
  const started = await startCodeHandshake(code, { allowV1: false })
  const done = await shakeHandsOverHttp(phoneHttp, started, async () => new Seal2RefusedError('code', 'refused'))
  const phone = runSeal2Link(phoneHttp, done.session as Seal2Session)
  const unlock = await sealedFetch(phone.connection, { method: 'POST', path: CANARY.route, headers: { authorization: CANARY.pairingToken, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: CANARY.prompt, password: CANARY.password }) })
  results.phoneV2 = `${unlock.status} ${Buffer.from(await readBody(unlock.body)).toString()}`
  const stream = await sealedFetch(phone.connection, { method: 'GET', path: '/api/events', headers: { authorization: CANARY.pairingToken } })
  const reader = stream.body.getReader()
  await reader.read()
  events?.(`data: ${CANARY.event}\n\n`)
  let got = ''
  while (!got.includes(CANARY.event)) got += Buffer.from((await reader.read()).value ?? new Uint8Array()).toString()
  results.phoneEvent = got.includes(CANARY.event) ? 'event arrived' : 'missing'
  stream.stream.abort(1, 'done')
  // In the clear on purpose, with the control's token: the Mac must refuse it (a v2 client itself never sends one).
  const refused = await withSession(phoneSession)(`${prefix}/api/after-v2`, { headers: { authorization: CONTROL.token } })
  results.phonePlainAfterV2 = `${refused.status} ${await refused.text()}`

  // 2. The account's other desktop, device mode, through sealPeers (openStream's own path).
  const peers = createSealPeers({ self: () => other.signer, verify: verifyDevice, relayed: (id, route, init) => withSession(otherSession)(`${origin}${machineRelayPath(id, route)}`, init), retryMs: 100 })
  const desk = await peers.fetch(mac.id, { method: 'POST', path: CANARY.deviceRoute, headers: { authorization: CANARY.machineKey }, body: CANARY.prompt })
  results.desktopDevice = `${desk.status} ${Buffer.from(await readBody(desk.body)).toString()}`

  // 3. An old phone, v1, still sealed.
  results.oldPhoneV1 = await oldPhoneGet(prefix, code, otherSession, CANARY.v1Route, CANARY.pairingToken)

  // 4. The control: in the clear on purpose, from a device that has not spoken v2 on the code.
  const plain = await withSession(otherSession)(`${prefix}${CONTROL.route}`, { method: 'POST', headers: { authorization: CONTROL.token }, body: CONTROL.body })
  results.control = `${plain.status} ${await plain.text()}`

  await new Promise((resolve) => setTimeout(resolve, 300))
  phone.close()
  peers.close()
  link.stop()
  terminus.close()
  macServer.close()
  tee.close()
  registry.stop()

  // The search.
  const captured = chunks.slice(signUpEnds)
  const raw = Buffer.concat(captured.map((chunk) => chunk.bytes)).toString('latin1')
  const readable = `${raw}\n${decodedRuns(raw)}`
  const codeForms = [Buffer.from(code).toString('base64url'), Buffer.from(code).toString('base64'), Buffer.from(code).toString('hex')]
  const findings = Object.fromEntries([
    ...Object.entries(CANARY).map(([name, value]) => [`canary ${name}`, readable.includes(value) || readable.includes(value.replace(/^Bearer /, ''))]),
    ...codeForms.map((form, i) => [`connect code form ${i}`, readable.includes(form)]),
    ...Object.entries(CONTROL).map(([name, value]) => [`control ${name} (must be found)`, readable.includes(value)])
  ])
  const leaked = Object.entries(findings).filter(([name, found]) => !name.startsWith('control') && found)
  const controlMissed = Object.entries(findings).filter(([name, found]) => name.startsWith('control') && !found)
  const report = {
    at: new Date().toISOString(),
    registry: 'unmodified registry/src server in its own process, every TCP byte teed on loopback',
    connections: new Set(captured.map((chunk) => chunk.conn)).size,
    bytesToRegistry: captured.filter((chunk) => chunk.dir === 'to-registry').reduce((total, chunk) => total + chunk.bytes.length, 0),
    bytesFromRegistry: captured.filter((chunk) => chunk.dir === 'from-registry').reduce((total, chunk) => total + chunk.bytes.length, 0),
    results,
    reachedTheMac: reached,
    findings,
    verdict: leaked.length === 0 && controlMissed.length === 0 ? 'PASS: no canary, path, body, token, password or code on the wire; the control was found' : 'FAIL',
    leaked: leaked.map(([name]) => name),
    controlMissed: controlMissed.map(([name]) => name)
  }
  const framed = Buffer.concat(
    captured.flatMap((chunk) => {
      const head = Buffer.alloc(9)
      head.writeUInt32BE(chunk.conn, 0)
      head.writeUInt8(chunk.dir === 'to-registry' ? 1 : 2, 4)
      head.writeUInt32BE(chunk.bytes.length, 5)
      return [head, chunk.bytes]
    })
  )
  writeFileSync(path.join(out, 'capture.bin'), framed)
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
  console.log(`capture: ${path.join(out, 'capture.bin')} (u32 conn | u8 dir 1=to registry 2=from | u32 length | bytes)`)
  process.exit(report.verdict.startsWith('PASS') ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
