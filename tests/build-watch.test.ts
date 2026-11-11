// THE COMPANION UPDATES ITSELF: the Mac names its build, the page reloads at
// the next switch away or back when the name changed — and never otherwise.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBuildId } from '../src/main/build-id'
import { watchBuild } from '../src/renderer/src/build-watch'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const repo = (head: string, refs: Record<string, string> = {}, packed?: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-build-'))
  mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(path.join(dir, '.git', 'HEAD'), head)
  for (const [ref, sha] of Object.entries(refs)) writeFileSync(path.join(dir, '.git', ref), `${sha}\n`)
  if (packed) writeFileSync(path.join(dir, '.git', 'packed-refs'), packed)
  return dir
}

describe('readBuildId', () => {
  it('reads a branch through a loose ref, a packed ref, or a detached HEAD', () => {
    expect(readBuildId(repo('ref: refs/heads/dev\n', { 'refs/heads/dev': SHA_A }), 'v')).toBe('a'.repeat(12))
    expect(readBuildId(repo('ref: refs/heads/dev\n', {}, `# pack-refs\n${SHA_B} refs/heads/dev\n`), 'v')).toBe('b'.repeat(12))
    expect(readBuildId(repo(`${SHA_A}\n`), 'v')).toBe('a'.repeat(12))
  })
  it('answers the fallback with no .git, as a packaged app', () => {
    expect(readBuildId(mkdtempSync(path.join(tmpdir(), 'cookrew-nogit-')), '0.3.0')).toBe('0.3.0')
  })
})

describe('watchBuild', () => {
  const harness = () => {
    let build: (id: string) => void = () => undefined
    let visible: () => void = () => undefined
    let reloads = 0
    watchBuild({
      onBuild: (cb) => ((build = cb), () => undefined),
      reload: () => void (reloads += 1),
      onVisibility: (cb) => ((visible = cb), () => undefined)
    })
    return { build: (id: string) => build(id), visible: () => visible(), reloads: () => reloads }
  }

  it('never reloads for the build it loaded, however often it hears it', () => {
    const h = harness()
    h.build('aaa')
    h.build('aaa')
    h.visible()
    expect(h.reloads()).toBe(0)
  })

  it('reloads at the next switch after the build changed — not the moment it hears', () => {
    const h = harness()
    h.build('aaa')
    h.build('bbb')
    expect(h.reloads()).toBe(0)
    h.visible()
    expect(h.reloads()).toBe(1)
  })

  it('ignores an empty or missing id', () => {
    const h = harness()
    h.build('')
    h.build('aaa')
    h.visible()
    expect(h.reloads()).toBe(0)
  })
})

describe('the wiring', () => {
  it('the stream names the build on open and on change; main reads it every minute; the boot watches it', () => {
    const api = readFileSync('src/main/mobile-api.ts', 'utf8')
    expect(api).toContain('send("build", { id: deps.build.id() })')
    expect(api).toContain('deps.build.bus.on("build", onBuild)')
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("buildBus.emit('build', next)")
    expect(main).toContain('build: { id: () => buildId, bus: buildBus }')
    // Started with the machine in scope and stopped when it is left (machine-session.ts),
    // and only on a machine's own page: there the page is that machine's build.
    const session = readFileSync('src/renderer/src/machine-session.ts', 'utf8')
    expect(session).toContain('reload: () => window.location.reload()')
    expect(session).toContain("document.addEventListener('visibilitychange', cb)")
    expect(session).toContain('!scopeNeedsMachine() && isRemoteMode() ? cookrew().onBuild : undefined')
    expect(readFileSync('src/renderer/src/main.tsx', 'utf8')).toContain('startMachineSession()')
  })
})
