import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { nativeImage, systemPreferences } from 'electron'
import type { Roi, UseTarget } from '../shared/use-url'
import { useUrl } from '../shared/use-url'
import { AdbDevice, adbRunner } from './adb-device'
import type { BrowserInstance } from './browser-instance'
import { CamDevice } from './cam-device'
import { cameraAccess, ElectronCaptureHost } from './capture-host'
import { LinuxScreenDevice, linuxSources, type LinuxEnv } from './linux-screen'
import { listMacScreens, MacInput, macWindowAlive } from './mac-bridge'
import { PixelInstance, type PixelDevice } from './pixel-instance'
import { SCREEN_FRAME_MAX_SIDE, ScreenDevice, screenCaptureRunner, screenFiles } from './screen-device'
import { grabScreenFrames, grabSources, openScreenRecordingSettings, primaryDisplayId } from './use-source-electron'
import { macSources } from './use-source-mac'
import type { UseSourceProvider } from './use-source-service'

/**
 * THE USES, BUILT FOR THIS MAC (computer, phone and hardware use).
 *
 * Every device is plain code against small deps (adb-device.ts,
 * screen-device.ts, cam-device.ts); this is the one place that hands them
 * Electron and the machine: nativeImage for JPEG work, systemPreferences for
 * the grants, the capture host for cameras, one input hand for the Mac.
 */

const ADB_PLACES = ['/opt/homebrew/bin/adb', '/usr/local/bin/adb', path.join(homedir(), 'Library/Android/sdk/platform-tools/adb')]

/** adb on PATH, else where Homebrew and the Android SDK put it — a GUI launch's PATH is short. */
export function findAdb(pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, 'adb'))) return path.join(dir, 'adb')
  }
  return ADB_PLACES.find((place) => existsSync(place)) ?? null
}

/** JPEG or PNG in; cropped by fractions, fitted to the long side, JPEG out. */
export function encodeJpeg(input: Buffer, crop: Roi | null, maxSide: number): Buffer {
  let image = nativeImage.createFromBuffer(input)
  if (image.isEmpty()) throw new Error('the captured image could not be read')
  if (crop) {
    const size = image.getSize()
    image = image.crop({
      x: Math.round(crop.x * size.width),
      y: Math.round(crop.y * size.height),
      width: Math.max(1, Math.round(crop.width * size.width)),
      height: Math.max(1, Math.round(crop.height * size.height))
    })
  }
  const { width, height } = image.getSize()
  const k = maxSide / Math.max(width, height)
  if (k < 1) image = image.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' })
  return image.toJPEG(70)
}

export interface UseInstances {
  makeInstance(target: UseTarget, node: { id: string }): BrowserInstance | null
  /** The window picker's source for this machine; null where there is none. */
  sources(): UseSourceProvider | null
  dispose(): void
}

export interface UseInstancesOptions {
  readonly captureDir: string
  readonly computerInput: () => boolean
  readonly platform?: NodeJS.Platform
  readonly env?: LinuxEnv
}

export function createUseInstances(options: UseInstancesOptions): UseInstances {
  const platform = options.platform ?? process.platform
  const env = (): LinuxEnv => options.env ?? process.env
  const screenAccess = (): string => systemPreferences.getMediaAccessStatus('screen')
  mkdirSync(options.captureDir, { recursive: true, mode: 0o700 })
  let hand: MacInput | null = null
  let host: ElectronCaptureHost | null = null
  const handOf = (): MacInput => (hand ??= new MacInput())
  const hostOf = (): ElectronCaptureHost => (host ??= new ElectronCaptureHost(path.join(options.captureDir, 'capture-host.html')))

  const deviceFor = (target: UseTarget): PixelDevice | null => {
    switch (target.kind) {
      case 'adb': {
        const adb = findAdb()
        // Not installed is a card that says how to install it, not a card that is missing.
        const run = adb ? adbRunner(adb) : () => Promise.reject(new Error('adb is not installed — brew install android-platform-tools'))
        return new AdbDevice(target, { run, toJpeg: (png, maxSide) => encodeJpeg(png, null, maxSide) })
      }
      case 'screen':
      case 'window':
        if (platform === 'linux') {
          return new LinuxScreenDevice(target, { env, frames: () => grabScreenFrames(SCREEN_FRAME_MAX_SIDE), primaryDisplayId })
        }
        if (platform !== 'darwin') return null
        return new ScreenDevice(target, {
          list: () => listMacScreens(),
          windowAlive: (id) => macWindowAlive(id),
          capture: screenCaptureRunner,
          read: screenFiles.read,
          remove: screenFiles.remove,
          encode: encodeJpeg,
          screenAccess,
          inputEnabled: options.computerInput,
          accessibility: () => systemPreferences.isTrustedAccessibilityClient(false),
          hand: handOf,
          tmp: options.captureDir
        })
      case 'cam':
        return new CamDevice(target, { host: hostOf, cameraAccess })
      default:
        return null
    }
  }

  return {
    makeInstance(target) {
      const device = deviceFor(target)
      return device ? new PixelInstance({ url: useUrl(target), device }) : null
    },
    sources() {
      if (platform === 'linux') return linuxSources({ env, grab: grabSources, primaryDisplayId })
      if (platform !== 'darwin') return null
      return macSources({
        access: screenAccess,
        screens: () => listMacScreens(),
        grab: grabSources,
        selfPid: process.pid,
        openSettings: () => openScreenRecordingSettings(screenAccess())
      })
    },
    dispose() {
      hand?.close()
      hand = null
      host?.dispose()
      host = null
    }
  }
}
