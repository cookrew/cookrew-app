// A BRIEF'S PICTURES REACH THE PHONE (owner, 2026-11-04): a brief sent by
// `cookrew ask` or `cookrew recruit --prompt` that names an image outside the
// attach store (/tmp/…/app-full.png) drew an empty tile on the phone, which
// may only read the store (prompt-image.ts). Such a picture is now copied
// into the store as the brief is sent, and the brief names the copy.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptPictures, adoptRequestPictures } from '../src/main/picture-adopt'
import { imagePathsIn } from '../src/shared/prompt-images'
import type { CliRequest } from '../src/shared/model'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const setup = (): { root: string; store: string; out: string } => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'picture-adopt-')))
  const store = path.join(root, 'attachments')
  const out = path.join(root, 'evals')
  mkdirSync(out, { recursive: true })
  return { root, store, out }
}

describe('adoptPictures', () => {
  it('copies an image outside the store into it and names the copy instead', async () => {
    const { store, out } = setup()
    const shot = path.join(out, 'app-full.png')
    writeFileSync(shot, PNG)
    const text = `BUG: cut off. Evidence: ${shot} (from eval.mjs).`
    const next = await adoptPictures(text, store)
    const [copy] = imagePathsIn(next)
    expect(path.dirname(copy)).toBe(store)
    expect(path.basename(copy)).toMatch(/^app-full-[0-9a-f]{10}\.png$/)
    expect(readFileSync(copy).equals(PNG)).toBe(true)
    expect(next).toBe(text.replace(shot, copy))
  })

  it('reuses the copy when the same picture is sent again', async () => {
    const { store, out } = setup()
    const shot = path.join(out, 'a.png')
    writeFileSync(shot, PNG)
    const once = await adoptPictures(shot, store)
    const twice = await adoptPictures(`again ${shot}`, store)
    expect(twice).toBe(`again ${once}`)
    expect(readdirSync(store)).toHaveLength(1)
  })

  it('keeps a picture already in the store, one that does not exist, and words with none', async () => {
    const { store, out } = setup()
    mkdirSync(store, { recursive: true })
    const inside = path.join(store, 'x.png')
    writeFileSync(inside, PNG)
    const text = `${inside} and ${path.join(out, 'gone.png')} and /etc/hosts`
    expect(await adoptPictures(text, store)).toBe(text)
    expect(await adoptPictures('no pictures here', store)).toBe('no pictures here')
    expect(readdirSync(store)).toEqual(['x.png'])
  })

  it('reads the store through its real path: a link into it is already inside', async () => {
    const { root, store } = setup()
    mkdirSync(store, { recursive: true })
    writeFileSync(path.join(store, 'y.png'), PNG)
    const link = path.join(root, 'store-link')
    symlinkSync(store, link)
    const text = `see ${path.join(link, 'y.png')}`
    expect(await adoptPictures(text, store)).toBe(text)
  })

  it('escapes a copy whose name needs it, as a dropped file is', async () => {
    const { store, out } = setup()
    const shot = path.join(out, 'my shot.png')
    writeFileSync(shot, PNG)
    const next = await adoptPictures(`look ${shot.replace(' ', '\\ ')} now`, store)
    const [copy] = imagePathsIn(next)
    expect(path.dirname(copy)).toBe(store)
    expect(next).toBe(`look ${copy.replace(/ /g, '\\ ')} now`)
  })

  it('leaves a directory named like a picture alone', async () => {
    const { store, out } = setup()
    const dir = path.join(out, 'folder.png')
    mkdirSync(dir)
    expect(await adoptPictures(dir, store)).toBe(dir)
  })
})

describe('adoptRequestPictures: the briefs the CLI sends', () => {
  const req = (cmd: string, args: string[], flags: Record<string, unknown> = {}): CliRequest =>
    ({ id: '1', terminalId: 't', cmd, args, flags }) as unknown as CliRequest
  const adopt = async (text: string): Promise<string> => text.replace('/tmp/a.png', '/store/a.png')

  it('rewrites the brief of an ask and of a recruit --prompt, as new requests', async () => {
    const ask = req('ask', ['Gauge', 'see /tmp/a.png'])
    const next = await adoptRequestPictures(ask, adopt)
    expect(next.args).toEqual(['Gauge', 'see /store/a.png'])
    expect(ask.args[1]).toBe('see /tmp/a.png')
    const recruit = await adoptRequestPictures(req('recruit', ['Fit'], { prompt: 'fix /tmp/a.png' }), adopt)
    expect(recruit.flags.prompt).toBe('fix /store/a.png')
  })

  it('leaves raw bytes, other commands and the agent name untouched', async () => {
    const raw = req('ask', ['/tmp/a.png', 'x'], { raw: '/tmp/a.png' })
    expect(await adoptRequestPictures(raw, adopt)).toBe(raw)
    const note = req('note', ['write', '/tmp/a.png'])
    expect(await adoptRequestPictures(note, adopt)).toBe(note)
    expect((await adoptRequestPictures(req('ask', ['/tmp/a.png', 'hi']), adopt)).args[0]).toBe('/tmp/a.png')
  })

  it('is what the socket server runs before every command', () => {
    const src = readFileSync(path.resolve('src/main/socket-server.ts'), 'utf8')
    const body = src.slice(src.indexOf('async function dispatch('))
    expect(body.slice(0, body.indexOf('switch (cmd)'))).toMatch(/adoptRequestPictures\(/)
  })
})
