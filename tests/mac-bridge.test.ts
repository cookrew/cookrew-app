import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
// THE MAC'S INPUT HAND (main/mac-bridge.ts), DRY: the real osascript helper
// builds every event and posts none, so this never moves the owner's mouse.
// It proves the JSON-line protocol, the closed vocabulary, and that one bad
// line is refused without knocking the next one out of step.
//
// OPT-IN (COOKREW_MAC_INPUT_TEST=1), like the real-Chrome tests: building
// CGEvents from a process macOS has not trusted can raise the system's
// "control this computer" dialog on the owner's screen, which a routine gate
// must never do.
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { MAC_INPUT_SCRIPT, MacInput, macKeyCode, readMacListedApp } from '../src/main/mac-bridge'

describe.skipIf(process.platform !== 'darwin' || process.env.COOKREW_MAC_INPUT_TEST !== '1')('MacInput (dry)', () => {
  it('answers each operation in order, and refuses a malformed one without losing step', async () => {
    const hand = new MacInput({ dry: true })
    try {
      await hand.send({ op: 'ping' })
      await hand.send({ op: 'click', x: 10, y: 10 })
      await hand.send({ op: 'drag', x1: 10, y1: 10, x2: 40, y2: 40, ms: 60 })
      await hand.send({ op: 'scroll', x: 10, y: 10, dx: 0, dy: 120 })
      await hand.send({ op: 'key', code: 36 })
      await hand.send({ op: 'type', text: 'hé 你好' })
      await expect(hand.send({ op: 'click', x: Number.NaN, y: 1 })).rejects.toThrow(/refused/)
      await expect(hand.send({ op: 'shell', cmd: 'ls' } as never)).rejects.toThrow(/refused/)
      await hand.send({ op: 'ping' })
    } finally {
      hand.close()
    }
  }, 20_000)
})

describe('macKeyCode', () => {
  it('knows the vocabulary keys and nothing else', () => {
    expect(macKeyCode('return')).toBe(36)
    expect(macKeyCode('escape')).toBe(53)
    expect(macKeyCode('command')).toBeNull()
  })
})

// A locked session gets no event at all. Run on the real helper with only its
// `locked` answer swapped, so this refuses BEFORE any CGEvent exists: nothing
// here can move the owner's mouse or raise the system's question.
describe.skipIf(process.platform !== 'darwin' || process.env.COOKREW_MAC_LOCK_TEST !== '1')('the hand on a locked Mac (real helper)', () => {
  it('refuses every operation that would reach the screen, and still answers a ping', async () => {
    const script = MAC_INPUT_SCRIPT.replace(/const locked = \(\) => \{.*\}\n/, 'const locked = () => true\n')
    expect(script).not.toBe(MAC_INPUT_SCRIPT)
    const hand = new MacInput({ spawnHelper: () => spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]) as never })
    await expect(hand.send({ op: 'ping' })).resolves.toBeUndefined()
    await expect(hand.send({ op: 'type', text: 'hunter2' })).rejects.toThrow(/locked/)
    await expect(hand.send({ op: 'key', code: 36 })).rejects.toThrow(/locked/)
    await expect(hand.send({ op: 'click', x: 1, y: 1 })).rejects.toThrow(/locked/)
    await expect(hand.send({ op: 'scroll', x: 1, y: 1, dx: 0, dy: 1 })).rejects.toThrow(/locked/)
    await expect(hand.send({ op: 'drag', x1: 1, y1: 1, x2: 2, y2: 2, ms: 60 })).rejects.toThrow(/locked/)
    hand.close()
  })
})

// Runs the real script: it asks who answers for a process and touches no
// permission, so unlike the hand above it can never raise a dialog.
describe('letting the hand go', () => {
  const helper = (): { child: ChildProcessWithoutNullStreams; ended: () => boolean; killed: () => boolean } => {
    const stdin = new EventEmitter() as unknown as { write: () => boolean; end: () => void; on: () => void }
    let ended = false
    let killed = false
    stdin.write = () => true
    stdin.end = () => void (ended = true)
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
      stderr: new EventEmitter(),
      exitCode: null,
      killed: false,
      kill: () => ((killed = true), true)
    }) as unknown as ChildProcessWithoutNullStreams
    return { child, ended: () => ended, killed: () => killed }
  }

  it('closes when nothing is in flight', async () => {
    const h = helper()
    const hand = new MacInput({ spawnHelper: () => h.child })
    const sent = hand.send({ op: 'ping' })
    h.child.stdout.emit('data', 'ok\n')
    await sent
    expect(hand.closeWhenIdle()).toBe(true)
    expect(h.ended()).toBe(true)
  })

  it('never cuts off what is in flight: a password going into a lock screen, say', () => {
    const h = helper()
    const hand = new MacInput({ spawnHelper: () => h.child })
    void hand.send({ op: 'ping' }).catch(() => undefined)
    expect(hand.closeWhenIdle()).toBe(false)
    expect(h.ended()).toBe(false)
    hand.close()
  })

  it('what the old helper does on its way out touches nothing of the new one', async () => {
    const helpers = [helper(), helper()]
    let made = 0
    const hand = new MacInput({ spawnHelper: () => helpers[made++].child })
    const first = hand.send({ op: 'ping' })
    helpers[0].child.stdout.emit('data', 'ok\n')
    await first
    hand.closeWhenIdle()
    const second = hand.send({ op: 'ping' })
    helpers[0].child.emit('exit', 0)
    helpers[1].child.stdout.emit('data', 'ok\n')
    await expect(second).resolves.toBeUndefined()
    hand.close()
  })

  it('close lets an op finish instead of killing it with the mouse button down', () => {
    const h = helper()
    const hand = new MacInput({ spawnHelper: () => h.child })
    void hand.send({ op: 'ping' }).catch(() => undefined)
    hand.close()
    expect(h.ended()).toBe(true)
    expect(h.killed()).toBe(false)
  })
})

// The real helper, and only `ping`, which touches no input. A fake child cannot show this:
// JXA's length is a string, so a comparison with 0 never ended the loop, and it spun a core.
describe.skipIf(process.platform !== 'darwin')('the real helper at the end of its stdin', () => {
  it('leaves by itself', async () => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_INPUT_SCRIPT])
    const left = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    child.stdout.once('data', () => child.stdin.end())
    child.stdin.write('{"op":"ping"}\n')
    const gone = await left
    child.kill('SIGKILL')
    expect(gone).toBe(true)
  })
})

describe.skipIf(process.platform !== 'darwin')('readMacListedApp', () => {
  it('answers with an app bundle, or with nothing when no app is behind the launch', async () => {
    const answer = await readMacListedApp()
    expect(answer === null || answer.endsWith('.app')).toBe(true)
  })

  it('finds the bundle in what macOS answers: a run under a terminal names that terminal', async () => {
    const answer = await readMacListedApp()
    if (process.env.TERM_PROGRAM === 'Cookrew') expect(answer).toMatch(/^\/.+\.app$/)
  })

  it('reads the path macOS keeps, not the pid: once the launcher has gone the pid names this process, and TCC still asks about the launcher', () => {
    const source = readFileSync('src/main/mac-bridge.ts', 'utf8')
    expect(source).toContain('responsibility_get_responsible_for_pid')
    expect(source).not.toContain('responsibility_get_pid_responsible_for_pid')
  })
})
