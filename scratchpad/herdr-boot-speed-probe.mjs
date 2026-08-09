// Boot-speed measurement for the herdr backend — the numbers behind the
// optimization. Simulates what the app does at launch: N terminals, each
// ensureSession + attachSpawn, SEQUENTIALLY (as PtySession construction does).
//
// Three scenarios:
//   cold   — fresh server, panes created and agents booted from nothing
//   warm   — server up, agents running: the everyday app relaunch
//   husk   — server restarted, panes restored without agents: reboot recovery

import { execFileSync } from 'node:child_process'

const SESSION = 'cookrewspeed'
const CONFIG = '/tmp/cookrew-herdr-e2e/cookrew.herdr.toml'
const N = 5
const env = { ...process.env, HERDR_SESSION: SESSION, HERDR_CONFIG_PATH: CONFIG }
const cli = (a) => {
  try {
    return execFileSync('herdr', a, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer.ts')

const spec = (i) => ({
  sessionName: `cookrew_speed${i}`,
  command: `node -e 'console.log("BOOTED_${i}"); setInterval(() => {}, 1e6)'`,
  shell: '/bin/sh',
  terminalId: `speed-${i}`,
  socketPath: '/tmp/sp.sock',
  cliDir: '/tmp/spcli',
  path: `/tmp/spcli:${process.env.PATH}`,
  cwd: '/tmp'
})

const bootAll = (mux) => {
  const t0 = Date.now()
  const per = []
  for (let i = 0; i < N; i++) {
    const s = Date.now()
    mux.ensureSession(spec(i))
    mux.attachSpawn(spec(i))
    per.push(Date.now() - s)
  }
  return { total: Date.now() - t0, per }
}

cli(['server', 'stop'])
await sleep(1000)

console.log(`--- COLD: ${N} terminals from nothing ---`)
const m1 = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
const cold = bootAll(m1)
console.log(`total ${cold.total}ms   per-terminal [${cold.per.join(', ')}]`)

await sleep(1500)
console.log(`--- WARM: same terminals, agents already running ---`)
const m2 = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
const warm = bootAll(m2)
console.log(`total ${warm.total}ms   per-terminal [${warm.per.join(', ')}]`)

console.log(`--- HUSK: server restarted, agents dead, panes restored ---`)
cli(['server', 'stop'])
await sleep(2000)
const m3 = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
const husk = bootAll(m3)
console.log(`total ${husk.total}ms   per-terminal [${husk.per.join(', ')}]`)

await sleep(3000)
const booted = cli(['pane', 'list'])
const count = (booted.match(/cookrew_speed/g) ?? []).length
console.log(`panes surviving: ${count}/${N}`)

cli(['server', 'stop'])
process.exit(0)
