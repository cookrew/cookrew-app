import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SHOT_MAX_WIDTH, WorkspaceShots, type ShotRect } from '../src/main/workspace-shots'

/**
 * THE PICTURES THE SCREEN WALL DRAWS.
 *
 * What matters here is not that a JPEG comes out — Electron does that — but
 * the rules around it: an id that arrives over IPC is about to become a path,
 * a capture that fails must cost nobody anything, a picture is capped in size
 * on purpose, and a workspace that is gone must not keep one.
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'ws-shots-'))
  dirs.push(d)
  return d
}

const RECT: ShotRect = { x: 0, y: 56, width: 1440, height: 900 }

/** A capturer that records what it was asked for and answers a fake image. */
function fake(bytes = Buffer.from('jpeg-bytes')) {
  const asked: { rect: ShotRect; resizedTo: number; quality: number }[] = []
  return {
    asked,
    capturer: {
      capture: async (rect: ShotRect) => ({
        resize: ({ width }: { width: number }) => ({
          toJPEG: (quality: number) => {
            asked.push({ rect, resizedTo: width, quality })
            return bytes
          },
        }),
      }),
    },
  }
}

describe('taking one', () => {
  it('writes a picture and remembers when', async () => {
    const base = scratch()
    const f = fake()
    const shots = new WorkspaceShots({ capturer: f.capturer, base })
    const before = Date.now()
    expect(await shots.capture('w1', RECT)).toBe(true)
    const at = shots.takenAt('w1')
    expect(at).not.toBeNull()
    expect(at!).toBeGreaterThanOrEqual(before - 2000)
    expect(readFileSync(path.join(base, 'workspace-shots', 'w1.jpg')).toString()).toBe('jpeg-bytes')
  })

  it('caps the width, because the wall never draws one bigger', async () => {
    // A full-resolution PNG per workspace is the trap this whole design is
    // avoiding: megabytes each, scaled down before anyone sees them.
    const f = fake()
    await new WorkspaceShots({ capturer: f.capturer, base: scratch() }).capture('w1', RECT)
    expect(f.asked[0].resizedTo).toBe(SHOT_MAX_WIDTH)
    expect(f.asked[0].quality).toBeLessThan(100)
  })

  it('does not blow a small canvas up to the cap', async () => {
    const f = fake()
    await new WorkspaceShots({ capturer: f.capturer, base: scratch() }).capture('w1', { ...RECT, width: 400 })
    expect(f.asked[0].resizedTo).toBe(400)
  })

  it('rounds the rect, because a capture takes whole pixels', async () => {
    const f = fake()
    await new WorkspaceShots({ capturer: f.capturer, base: scratch() })
      .capture('w1', { x: 0.4, y: 55.6, width: 1439.5, height: 899.2 })
    expect(f.asked[0].rect).toEqual({ x: 0, y: 56, width: 1440, height: 899 })
  })

  it('answers false instead of throwing when the capture fails', async () => {
    // This runs while somebody is opening a switcher. The cost of a failure is
    // one screen with no picture on it, never a surface that does not open.
    const shots = new WorkspaceShots({
      capturer: { capture: async () => { throw new Error('window gone') } },
      base: scratch(),
    })
    await expect(shots.capture('w1', RECT)).resolves.toBe(false)
    expect(shots.takenAt('w1')).toBeNull()
  })

  it('refuses a rect with no area, rather than writing an empty file', async () => {
    const f = fake()
    const shots = new WorkspaceShots({ capturer: f.capturer, base: scratch() })
    expect(await shots.capture('w1', { x: 0, y: 0, width: 0, height: 900 })).toBe(false)
    expect(f.asked).toHaveLength(0)
  })

  it('writes nothing when the encoder answers nothing', async () => {
    const shots = new WorkspaceShots({ capturer: fake(Buffer.alloc(0)).capturer, base: scratch() })
    expect(await shots.capture('w1', RECT)).toBe(false)
    expect(shots.takenAt('w1')).toBeNull()
  })

  it('does nothing at all with no window to capture from', async () => {
    const shots = new WorkspaceShots({ capturer: null, base: scratch() })
    expect(await shots.capture('w1', RECT)).toBe(false)
  })
})

describe('the id is about to become a path, so it is checked', () => {
  it('refuses anything that is not a plain token', async () => {
    const base = scratch()
    const shots = new WorkspaceShots({ capturer: fake().capturer, base })
    for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(65), 'a b']) {
      expect(shots.fileFor(bad), bad).toBeNull()
      expect(await shots.capture(bad, RECT), bad).toBe(false)
    }
    expect(existsSync(path.join(base, 'workspace-shots'))).toBe(false)
  })

  it('accepts the shapes a workspace id actually has', () => {
    const shots = new WorkspaceShots({ capturer: null, base: scratch() })
    for (const ok of ['w1', 'ws_2', 'a-b-c', '9f3c1e4a-2b7d-4e51-9a0c-6d2f8b1e7c33']) {
      expect(shots.fileFor(ok), ok).not.toBeNull()
    }
  })
})

describe('reading them for the wall', () => {
  it('hands back data URLs with the time each was taken', async () => {
    const base = scratch()
    const shots = new WorkspaceShots({ capturer: fake().capturer, base })
    await shots.capture('w1', RECT)
    await shots.capture('w2', RECT)
    const all = shots.all()
    expect(Object.keys(all).sort()).toEqual(['w1', 'w2'])
    expect(all.w1.src.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(all.w1.src.split(',')[1], 'base64').toString()).toBe('jpeg-bytes')
    expect(all.w1.at).toBeGreaterThan(0)
  })

  it('is empty, not a throw, before anything has been captured', () => {
    expect(new WorkspaceShots({ capturer: null, base: scratch() }).all()).toEqual({})
  })

  it('skips a file it cannot use instead of failing the whole wall', async () => {
    const base = scratch()
    const shots = new WorkspaceShots({ capturer: fake().capturer, base })
    await shots.capture('good', RECT)
    const dir = path.join(base, 'workspace-shots')
    writeFileSync(path.join(dir, 'empty.jpg'), '')
    writeFileSync(path.join(dir, 'notes.txt'), 'x')
    writeFileSync(path.join(dir, '../stray.jpg'), 'x')
    const all = shots.all()
    expect(Object.keys(all)).toEqual(['good'])
  })
})

describe('forgetting', () => {
  it('drops the picture of a workspace that was removed', async () => {
    const base = scratch()
    const shots = new WorkspaceShots({ capturer: fake().capturer, base })
    await shots.capture('w1', RECT)
    shots.forget('w1')
    expect(shots.takenAt('w1')).toBeNull()
    expect(shots.all()).toEqual({})
  })

  it('is quiet about a workspace that never had one', () => {
    const shots = new WorkspaceShots({ capturer: null, base: scratch() })
    expect(() => shots.forget('never')).not.toThrow()
    expect(() => shots.forget('../bad')).not.toThrow()
  })

  it('sweeps pictures this process never saw removed', async () => {
    // A store edited by another instance, or a workspace deleted before this
    // feature existed. Without the sweep the directory has no ceiling.
    const shots = new WorkspaceShots({ capturer: fake().capturer, base: scratch() })
    await shots.capture('live', RECT)
    await shots.capture('ghost1', RECT)
    await shots.capture('ghost2', RECT)
    expect(shots.sweep(['live'])).toBe(2)
    expect(Object.keys(shots.all())).toEqual(['live'])
  })

  it('sweeps nothing when every picture belongs to a live workspace', async () => {
    const shots = new WorkspaceShots({ capturer: fake().capturer, base: scratch() })
    await shots.capture('a', RECT)
    expect(shots.sweep(['a', 'b'])).toBe(0)
    expect(Object.keys(shots.all())).toEqual(['a'])
  })
})
