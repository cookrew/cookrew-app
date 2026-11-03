import { BrowserWindow, session, systemPreferences } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { CameraHost } from './cam-device'

/**
 * THE CAPTURE HOST: ONE HIDDEN WINDOW THAT HOLDS THE CAMERAS.
 *
 * Electron's main process cannot open a camera; a page can. So a camera card
 * is served by one hidden window (created on first use, never shown) that
 * opens each camera with getUserMedia and reads it through a
 * MediaStreamTrackProcessor, keeping only the newest VideoFrame. A grab
 * draws that frame onto an OffscreenCanvas at the card's size and hands back
 * a JPEG — nothing is composited on screen, so a hidden window is not
 * throttled into silence the way an occluded <webview> is.
 *
 * The page is a file: a getUserMedia needs a secure context, and file: is
 * one where data: is not. Its session is its own partition, which grants
 * `media` and nothing else, to this window and nothing else.
 *
 * A camera that is unplugged ends its track; the next grab says so, the
 * instance goes offline (pixel-instance.ts) and opens it again when it is
 * back. The window is closed with the main window, or a hidden window would
 * keep the app from quitting.
 */

const PARTITION = 'cookrew-capture'

const PAGE = '<!doctype html><meta charset="utf-8"><title>cookrew capture</title>'

const SCRIPT = `
window.__cams = window.__cams || new Map()
window.__camOpen = async (want) => {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
  if (all.length === 0) throw new Error('No camera is connected to this Mac')
  const index = /^\\d+$/.test(want) ? Number(want) : -1
  const device = index >= 0 ? all[index] : all.find((d) => d.label.toLowerCase().includes(want.toLowerCase()))
  if (!device) throw new Error('No camera matches ' + JSON.stringify(want) + ' (cameras: ' + all.map((d, i) => i + ' ' + (d.label || 'unnamed')).join(', ') + ')')
  const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: device.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } })
  const track = stream.getVideoTracks()[0]
  const key = Math.random().toString(36).slice(2)
  const cam = { track, latest: null, ended: false }
  track.addEventListener('ended', () => { cam.ended = true })
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) { cam.ended = true; break }
      if (cam.latest) cam.latest.close()
      cam.latest = value
    }
  })().catch(() => { cam.ended = true })
  window.__cams.set(key, cam)
  const s = track.getSettings()
  return { key, width: s.width || 1280, height: s.height || 720, label: device.label || ('Camera ' + want) }
}
window.__camGrab = async (key, maxSide) => {
  const cam = window.__cams.get(key)
  if (!cam) throw new Error('the camera is not open')
  if (cam.ended) throw new Error('the camera was disconnected')
  const frame = cam.latest
  if (!frame) throw new Error('the camera has not sent a frame yet')
  const w0 = frame.displayWidth, h0 = frame.displayHeight
  const k = Math.min(1, maxSide / Math.max(w0, h0))
  const w = Math.round(w0 * k), h = Math.round(h0 * k)
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(frame, 0, 0, w, h)
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return { jpeg: btoa(s), width: w0, height: h0 }
}
window.__camClose = (key) => {
  const cam = window.__cams.get(key)
  if (!cam) return
  window.__cams.delete(key)
  if (cam.latest) cam.latest.close()
  cam.track.stop()
}
true
`

export class ElectronCaptureHost implements CameraHost {
  private window: Promise<BrowserWindow> | null = null

  constructor(private readonly pageFile: string) {}

  private ready(): Promise<BrowserWindow> {
    if (this.window) return this.window
    const opening = (async (): Promise<BrowserWindow> => {
      const ses = session.fromPartition(PARTITION)
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'))
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'media')
      await writeFile(this.pageFile, PAGE)
      const win = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true }
      })
      win.on('closed', () => {
        if (this.window === opening) this.window = null
      })
      await win.loadFile(this.pageFile)
      await win.webContents.executeJavaScript(SCRIPT)
      return win
    })()
    this.window = opening
    opening.catch(() => {
      if (this.window === opening) this.window = null
    })
    return opening
  }

  private async call<T>(expression: string): Promise<T> {
    const win = await this.ready()
    try {
      return (await win.webContents.executeJavaScript(expression)) as T
    } catch (error) {
      // executeJavaScript wraps the page's Error; keep only its sentence.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.replace(/^.*?Error:\s*/s, ''))
    }
  }

  open(name: string): Promise<{ key: string; width: number; height: number; label: string }> {
    return this.call(`window.__camOpen(${JSON.stringify(name)})`)
  }

  grab(key: string, maxSide: number): Promise<{ jpeg: string; width: number; height: number }> {
    return this.call(`window.__camGrab(${JSON.stringify(key)}, ${Math.round(maxSide)})`)
  }

  async close(key: string): Promise<void> {
    if (!this.window) return
    await this.call(`window.__camClose(${JSON.stringify(key)})`)
  }

  dispose(): void {
    const pending = this.window
    this.window = null
    void pending?.then((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
  }
}

let asking: Promise<boolean> | null = null

/**
 * macOS's camera grant. The first time, the dialog is raised and `asking`
 * answered at once; the instance retries and finds `granted` (or `denied`)
 * once the owner answers. A refusal is remembered by macOS, not here.
 */
export async function cameraAccess(): Promise<'granted' | 'denied' | 'asking'> {
  if (process.platform !== 'darwin') return 'granted'
  const status = systemPreferences.getMediaAccessStatus('camera')
  if (status === 'granted') return 'granted'
  if (status !== 'not-determined') return 'denied'
  asking ??= systemPreferences.askForMediaAccess('camera').finally(() => {
    asking = null
  })
  return 'asking'
}
