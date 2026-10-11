// THE ROUTE RIDES EVERY BACKEND THE WAY COOKREW_* DOES (route program, core).
// tmux and herdr bake it into the boot script, herdr's split pane takes it as
// --env, the direct backend hands it to the spawn options; the args land on
// the command line shell-quoted; a served pane never carries any of it.

import { describe, expect, it } from 'vitest'
import type { AttachSpec } from '../src/main/multiplexer'
import { bootScript, commandWithArgs, routeExports, shellQuote } from '../src/main/tmux-multiplexer'
import { bootCommand, envArgs } from '../src/main/herdr-host-multiplexer'
import { DirectMultiplexer } from '../src/main/direct-multiplexer'
import { routeEnv } from '../src/main/route-env'

const base: AttachSpec = {
  sessionName: 'cookrew-card-1',
  command: 'codex',
  shell: '/bin/zsh',
  terminalId: 'card-1',
  socketPath: '/tmp/cookrew.sock',
  cliDir: '/tmp/cli',
  path: '/tmp/cli:/usr/bin',
  cwd: '/work'
}
const gateway = { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew' }

describe('the route on the command line', () => {
  it('appends codex args shell-quoted, the inline table in single quotes', () => {
    const r = routeEnv({ harness: 'codex', gateway, model: 'group/smart', cardId: 'card-1' })
    const line = commandWithArgs({ ...base, args: r.args })
    expect(line.startsWith('codex -c model_provider=magpie ')).toBe(true)
    expect(line).toContain(`-c 'model_providers.magpie.http_headers={"X-Magpie-Session"="cookrew:card-1"}'`)
    expect(line.endsWith('-c model=group/smart')).toBe(true)
  })

  it('a bare login shell takes no args', () => {
    expect(commandWithArgs({ ...base, command: '', args: ['-c', 'x=1'] })).toBe('/bin/zsh -l')
  })

  it('shellQuote contains a single quote the POSIX way', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
    expect(shellQuote('plain=1')).toBe('plain=1')
  })
})

describe('tmux and herdr boot scripts', () => {
  it('export the route env after PATH and before the exec, values quoted', () => {
    const r = routeEnv({ harness: 'claude', gateway, model: 'group/smart', cardId: 'card-1' })
    const spec = { ...base, command: 'claude', env: r.env, args: r.args }
    for (const script of [bootScript(spec), bootCommand(spec)]) {
      const parts = script.split('; ')
      const pathAt = parts.findIndex((p) => p.startsWith('export PATH='))
      const execAt = parts.findIndex((p) => p.startsWith('exec '))
      const exports = routeExports(spec)
      expect(exports).toContain(`export ANTHROPIC_BASE_URL=http://127.0.0.1:3425`)
      expect(exports).toContain(`export ANTHROPIC_CUSTOM_HEADERS='X-Magpie-Session: cookrew:card-1'`)
      for (const line of exports) {
        const at = parts.indexOf(line)
        expect(at).toBeGreaterThan(pathAt)
        expect(at).toBeLessThan(execAt)
      }
      expect(parts[execAt]).toBe('exec claude')
    }
  })

  it('without a route the scripts are byte-identical to before', () => {
    const before = bootScript(base)
    expect(before).not.toContain('ANTHROPIC')
    expect(before.split('; ')).toHaveLength(6)
    expect(bootCommand(base).split('; ')).toHaveLength(6)
  })

  it('herdr --env carries the route entries after the five of Cookrew', () => {
    const args = envArgs({ ...base, env: { MAGPIE_GATEWAY_KEY: 'magpie-cookrew' } })
    expect(args.slice(-2)).toEqual(['--env', 'MAGPIE_GATEWAY_KEY=magpie-cookrew'])
    expect(args.filter((a) => a === '--env')).toHaveLength(6)
    expect(envArgs(base).filter((a) => a === '--env')).toHaveLength(5)
  })
})

describe('the direct backend', () => {
  it('passes the route env on the spawn options and the args on the line', () => {
    const mux = new DirectMultiplexer()
    const r = routeEnv({ harness: 'codex', gateway, model: 'deepseek/deepseek-chat', cardId: 'card-2' })
    const spawn = mux.attachSpawn({ ...base, env: r.env, args: r.args })
    expect(spawn.file).toBe('/bin/zsh')
    expect(spawn.args[0]).toBe('-l')
    expect(spawn.args[1]).toBe('-c')
    expect(spawn.args[2]).toContain('codex -c model_provider=magpie')
    expect(spawn.env).toEqual({ MAGPIE_GATEWAY_KEY: 'magpie-cookrew' })
    expect(mux.attachSpawn(base)).toEqual({ file: '/bin/zsh', args: ['-l', '-c', 'codex'] })
  })
})
