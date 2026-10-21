#!/usr/bin/env node
// Strata preview: the cookrew.dev shell (src/strata) on a plain Vite dev server
// with a mock fleet behind it — no Electron, no registry, no relay, nothing of
// the owner's running app. Every lane runs its own copy on its own port.
//
//   npm run strata:preview -- [--port 5280] [--fixture scratchpad/strata/fleet-real.json] [--auth]
//
// --fixture puts a real machine (written by scratchpad/strata/make-fixture.mjs)
// in front of the synthetic ones. The mock answers the production shapes of
// src/shared/strata.ts:
//   GET /fleet.json                      FleetMachine[]   (the registry's list)
//   GET /m/<id>/api/levels               LevelsSnapshot   (that desktop)
//   GET /m/<id>/api/levels/stream        text/event-stream: a snapshot, then a
//                                        phase change every ~2 s on live machines
//   GET /m/<id>/api/levels/agents/<aid>  LevelsAgentDetail, made up from the
//                                        attachment rows (no real note bodies)
//   GET /v2/me/desktops                  the same rows as /fleet.json, at the registry's path
//   GET /v2/me/desktops/presence         FleetPresence
//   GET /m/<id>/?embed=agent&agent=<aid> src/strata/embed/stand-in.html when the tree has one,
//                                        under the production URL (it must find its base
//                                        from location.pathname)
//   GET /preview/cache.json              PREVIEW ONLY: { [machineId]: LevelsSnapshot }
//                                        for offline machines, standing in for the
//                                        shell's own last-known cache
// Offline machines answer 503; the never-reached one 404s.
//
// FAILURE SWITCHES (scripts/strata-mock-gate.mjs), read with GET /mock/switch and set
// with POST /mock/switch {auth?, storm?: [ids], hang?: [ids]}:
//   auth   /m/<id>/api/* wants the pairing token mock-pairing-token-<id> as Bearer or
//          ?token= (GET /mock/pair lists them for a QA page to store), else 401
//   storm  everything under /m/<id>/ answers the relay's 503 too_many_exchanges
//   hang   everything under /m/<id>/ is held unanswered and its open streams go silent
// --auth starts with auth on.
//
// The dep cache lives in /tmp: a worktree's node_modules resolves to the main
// tree's, and sharing node_modules/.vite with the live app's dev server makes
// both re-optimise and force-reload the owner's desktop.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gate, mockToken, MOCK_SWITCHES, nextSwitches, tokenOf } from './strata-mock-gate.mjs'

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', process.env.STRATA_PORT ?? 5280))
const fixtureFile = arg('fixture', process.env.STRATA_FIXTURE)
const STAND_IN = path.join(tree, 'src', 'strata', 'embed', 'stand-in.html')
const RESERVED = new Set([5173, 8639, 8643, 9333, 9245])
if (RESERVED.has(port)) throw new Error(`port ${port} belongs to the live app or its QA tools — pick another`)

const realMachines = () => {
  if (!fixtureFile) return []
  const doc = JSON.parse(readFileSync(path.resolve(fixtureFile), 'utf8'))
  return doc.machines.map((m) => ({ ...m, levels: m.levels && { ...m.levels, machine: { name: m.name, appVersion: m.appVersion, profile: m.profile } } }))
}

const TICK_MS = 2000
const NEXT = { idle: 'thinking', thinking: 'replied', replied: 'idle', waiting: 'thinking' }

/** Mock fleet: per-machine snapshots advanced by a timer, immutably. */
const mockFleet = (machines) => {
  let state = new Map(machines.map((m) => [m.id, m]))
  const listeners = new Map()
  let tick = 0
  const advance = () => {
    tick += 1
    for (const machine of state.values()) {
      if (!machine.online || !machine.levels) continue
      const live = machine.levels.workspaces.filter((w) => w.agents.length > 0)
      if (live.length === 0) continue
      const workspace = live[tick % live.length]
      const index = (tick * 7) % workspace.agents.length
      const before = workspace.agents[index]
      const phase = tick % 11 === 0 ? 'waiting' : NEXT[before.phase] ?? 'idle'
      const agent = {
        ...before,
        phase,
        phaseSince: Date.now(),
        phaseSource: workspace.state === 'focused' ? 'live' : 'probe',
        status: phase === 'thinking' ? 'Working… (0s)' : null,
        turns: phase === 'replied' ? before.turns + 1 : before.turns
      }
      const rev = machine.levels.rev + 1
      const workspaces = machine.levels.workspaces.map((w) =>
        w.id === workspace.id ? { ...w, agents: w.agents.map((a, i) => (i === index ? agent : a)) } : w
      )
      state = new Map(state).set(machine.id, { ...machine, levels: { ...machine.levels, rev, at: Date.now(), workspaces } })
      const event = { type: 'agent', rev, workspaceId: workspace.id, agent }
      for (const send of listeners.get(machine.id) ?? []) send(event)
    }
  }
  setInterval(advance, TICK_MS).unref()
  return {
    list: () => [...state.values()],
    get: (id) => state.get(id),
    subscribe: (id, send) => {
      listeners.set(id, new Set([...(listeners.get(id) ?? []), send]))
      return () => listeners.set(id, new Set([...(listeners.get(id) ?? [])].filter((s) => s !== send)))
    }
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const bodyOf = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

const urlOfHost = (host) => (!host ? null : host.startsWith('file · ') ? `file:///preview/${host.slice(7)}` : `https://${host}`)

/** The embed's bootstrap for one agent, made up from what the snapshot already says. */
const detailOf = (levels, agentId) => {
  const workspace = levels.workspaces.find((w) => w.agents.some((a) => a.id === agentId))
  if (!workspace) return null
  const agent = workspace.agents.find((a) => a.id === agentId)
  const notes = agent.attachments
    .filter((a) => a.kind === 'note')
    .map((a) => ({ id: a.id, title: a.title, content: `${a.title}\n\nA preview note body for ${agent.name}.`, shared: a.shared }))
  const browsers = agent.attachments
    .filter((a) => a.kind === 'browser')
    .map((a) => {
      const url = urlOfHost(a.host)
      const tabs = url ? Array.from({ length: a.tabs ?? 1 }, (_, i) => ({ id: `${a.id}-t${i}`, url })) : []
      return { id: a.id, title: a.title, url, tabs, live: workspace.state === 'focused', shared: a.shared }
    })
  return { agent, workspaceId: workspace.id, notes, browsers }
}

const mockPlugin = () => ({
  name: 'strata-mock-fleet',
  async configureServer(server) {
    const { syntheticFleet } = await server.ssrLoadModule('/fixture/synthetic.ts')
    const fleet = mockFleet([...realMachines(), ...syntheticFleet(Date.now())])
    let switches = { ...MOCK_SWITCHES, auth: process.argv.includes('--auth') }
    const handle = async (req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://preview')
      if (url.pathname === '/mock/switch') {
        if (req.method !== 'POST') return json(res, 200, switches)
        try {
          switches = nextSwitches(switches, await bodyOf(req))
          return json(res, 200, switches)
        } catch (error) {
          return json(res, 400, { error: 'bad_switch', message: error.message })
        }
      }
      if (url.pathname === '/mock/pair') return json(res, 200, Object.fromEntries(fleet.list().map((m) => [m.id, mockToken(m.id)])))
      if (url.pathname === '/fleet.json' || url.pathname === '/v2/me/desktops') {
        const rows = fleet.list().map(({ levels, ...m }) => ({ ...m, base: `/m/${m.id}/` }))
        return json(res, 200, rows)
      }
      if (url.pathname === '/v2/me/desktops/presence') {
        return json(res, 200, { at: Date.now(), machines: fleet.list().map((m) => ({ id: m.id, online: m.online, lastSeenAt: m.lastSeenAt })) })
      }
      const under = url.pathname.match(/^\/m\/([^/]+)\//)
      if (under) {
        const machineId = decodeURIComponent(under[1])
        const refusal = gate(switches, { machineId, api: url.pathname.startsWith(`${under[0]}api/`), token: tokenOf(req.headers, url) })
        if (refusal === 'hang') return
        if (refusal) return json(res, refusal.status, refusal.body)
        if (url.pathname === under[0] && url.searchParams.get('embed') === 'agent') {
          if (!existsSync(STAND_IN)) return json(res, 404, { error: 'no stand-in embed in this tree (src/strata/embed/stand-in.html)' })
          try {
            // relative src/href would resolve under /m/<id>/, not next to the file
            const raw = readFileSync(STAND_IN, 'utf8').replace(/(src|href)="\.\//g, '$1="/embed/')
            const html = await server.transformIndexHtml('/embed/stand-in.html', raw, req.originalUrl)
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            return res.end(html)
          } catch (error) {
            return next(error)
          }
        }
      }
      if (url.pathname === '/preview/cache.json') {
        const cached = fleet.list().filter((m) => !m.online && m.levels)
        return json(res, 200, Object.fromEntries(cached.map((m) => [m.id, m.levels])))
      }
      const match = url.pathname.match(/^\/m\/([^/]+)\/api\/levels(?:\/(stream)|\/agents\/([^/]+))?$/)
      if (!match) return next()
      const machine = fleet.get(decodeURIComponent(match[1]))
      if (!machine) return json(res, 404, { error: 'no such machine' })
      if (!machine.online || !machine.levels) return json(res, machine.levels ? 503 : 404, { error: 'offline' })
      if (match[3]) {
        const detail = detailOf(machine.levels, decodeURIComponent(match[3]))
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'no such agent' })
      }
      if (!match[2]) return json(res, 200, machine.levels)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const quiet = () => switches.hang.includes(machine.id)
      const send = (event) => quiet() || res.write(`data: ${JSON.stringify(event)}\n\n`)
      send({ type: 'snapshot', snapshot: fleet.get(machine.id).levels })
      const unsubscribe = fleet.subscribe(machine.id, send)
      const ping = setInterval(() => quiet() || res.write(':\n\n'), 15000)
      req.on('close', () => {
        clearInterval(ping)
        unsubscribe()
      })
    }
    // async, so a throw (a malformed %-escape) must reach Connect as an error, not kill the preview
    server.middlewares.use((req, res, next) => handle(req, res, next).catch(next))
  }
})

const server = await createServer({
  root: path.join(tree, 'src', 'strata'),
  cacheDir: `/tmp/strata-vite-cache-${port}`,
  configFile: false,
  appType: 'spa',
  plugins: [react(), mockPlugin()],
  server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [tree] } }
})
await server.listen()
console.log(`strata preview: http://127.0.0.1:${port}/me${fixtureFile ? `  (real machine from ${fixtureFile})` : ''}`)
