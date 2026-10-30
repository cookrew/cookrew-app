import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { connectPage, findChrome, launchChrome, serveBuild, waitForCanvas, type CdpPage, type Served } from '../scripts/perf-dom-probe.mjs'

/**
 * THE FINDER SURVIVES TYPING.
 *
 * The finder's effects hand the shell's callbacks their return value as the
 * effect cleanup. The shell's onActive answered `target && …` — null when the
 * finder had no current hit (an empty query with nobody waiting, or a query
 * matching nobody) — and React then called null as the cleanup on the next
 * keystroke: the whole main view fell into "Canvas crashed".
 *
 * The real App on the demo api, built with Vite and driven in a headless
 * Chrome: / opens the finder, a query that matches nobody, erased again.
 * There is no DOM test environment in this project, so the keys are a
 * browser's. Without a Chrome the file reports why and skips.
 */

const RENDERER = path.join(__dirname, '..', 'src', 'renderer')
const chrome = findChrome()
if (!chrome) process.stdout.write('levels-finder-typing: no Chrome found — skipped (set COOKREW_CHROME)\n')
const describeWithChrome = chrome ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function press(page: CdpPage, key: string, code: string, vk: number, text?: string): Promise<void> {
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
}

describeWithChrome('the levels finder, typed into', () => {
  let out = ''
  let served: Served | null = null

  beforeAll(async () => {
    out = mkdtempSync(path.join(tmpdir(), 'cookrew-levels-finder-'))
    await build({ root: RENDERER, configFile: false, logLevel: 'silent', base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true } })
    served = await serveBuild(out, null, { remote: false })
  }, 240_000)

  afterAll(() => {
    served?.close()
    if (out) rmSync(out, { recursive: true, force: true })
  })

  it('a query that matches nobody, erased again, keeps the levels on screen', async () => {
    const browser = await launchChrome({ width: 1280, height: 900, chrome })
    const errors: string[] = []
    try {
      const page: CdpPage = await connectPage(browser.port)
      await page.send('Runtime.enable')
      page.on('Runtime.exceptionThrown', (p: { exceptionDetails?: { text?: string } }) => errors.push(p.exceptionDetails?.text ?? 'exception'))
      await page.send('Page.navigate', { url: `http://127.0.0.1:${served!.port}/` })
      await waitForCanvas(page, 60_000, 1500)
      await sleep(2500)
      expect(await page.evaluate<boolean>(`!!document.querySelector('.cr-levels .level')`)).toBe(true)

      await press(page, '/', 'Slash', 191, '/')
      await sleep(400)
      expect(await page.evaluate<boolean>(`!!document.querySelector('.cr-levels .finder')`)).toBe(true)
      await page.send('Input.insertText', { text: 'qqzzx' })
      await sleep(300)
      // Erased back to empty: the finder lists who is waiting again, so the active hit comes back.
      for (let i = 0; i < 5; i++) await press(page, 'Backspace', 'Backspace', 8)
      await sleep(600)

      const state = await page.evaluate<{ level: boolean; finder: boolean; crashed: boolean }>(
        `({ level: !!document.querySelector('.cr-levels .level'), finder: !!document.querySelector('.cr-levels .finder'), crashed: !!document.querySelector('.crash-panel') })`
      )
      expect(state).toEqual({ level: true, finder: true, crashed: false })
      expect(errors).toEqual([])
    } finally {
      await browser.kill()
    }
  }, 120_000)
})
