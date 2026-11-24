import { BrowserWindow, session } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EncoderPage } from './cast-encoder'

/**
 * THE HIDDEN WINDOW THE ENCODER RUNS IN (cast-encoder.ts).
 *
 * A file page, because WebCodecs needs a secure context and file: is one where
 * data: is not (capture-host.ts learned the same). Its partition grants no
 * permission at all, and nothing is ever composited: backgroundThrottling is
 * off so a hidden window still encodes at speed. Closed with the app.
 */

const PARTITION = 'cookrew-cast-encoder'
const PAGE = '<!doctype html><meta charset="utf-8"><title>cookrew encoder</title>'

export class ElectronEncoderWindow {
  private window: Promise<BrowserWindow> | null = null

  constructor(private readonly pageFile: string) {}

  private ready(): Promise<BrowserWindow> {
    if (this.window) return this.window
    const opening = (async (): Promise<BrowserWindow> => {
      const ses = session.fromPartition(PARTITION)
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      await mkdir(path.dirname(this.pageFile), { recursive: true })
      await writeFile(this.pageFile, PAGE)
      const win = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true }
      })
      win.on('closed', () => {
        if (this.window === opening) this.window = null
      })
      // A renderer that crashed takes its encoders with it: the window goes, and
      // the next viewer gets a new one (cast-encoder.ts · forget).
      win.webContents.on('render-process-gone', () => {
        if (this.window === opening) this.window = null
        if (!win.isDestroyed()) win.destroy()
      })
      await win.loadFile(this.pageFile)
      return win
    })()
    this.window = opening
    opening.catch(() => {
      if (this.window === opening) this.window = null
    })
    return opening
  }

  /** The page, for createCastEncoder. */
  page = async (): Promise<EncoderPage> => {
    const win = await this.ready()
    return {
      run: async <T>(expression: string): Promise<T> => {
        if (win.isDestroyed()) throw new Error('The encoder window is gone.')
        try {
          return (await win.webContents.executeJavaScript(expression)) as T
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(message.replace(/^.*?Error:\s*/s, ''))
        }
      }
    }
  }

  dispose(): void {
    const pending = this.window
    this.window = null
    void pending?.then((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
  }
}
