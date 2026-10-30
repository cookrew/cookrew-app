// A CAMERA ON THE BENCH (main/cam-device.ts): watched, never driven; the grant
// refuses in words; a reopen closes the old camera first.
import { describe, expect, it } from 'vitest'
import { CAMERA_ASKING, CAMERA_OFF, CamDevice, type CameraHost } from '../src/main/cam-device'
import { parseUseUrl } from '../src/shared/use-url'

function host() {
  const log: string[] = []
  let n = 0
  const h: CameraHost = {
    open: async (name) => {
      n += 1
      log.push(`open ${name}`)
      return { key: `k${n}`, width: 1280, height: 720, label: 'Payphone 2-dollar Camera' }
    },
    grab: async (key) => {
      log.push(`grab ${key}`)
      return { jpeg: 'J', width: 1280, height: 720 }
    },
    close: async (key) => {
      log.push(`close ${key}`)
    }
  }
  return { h, log }
}

describe('CamDevice', () => {
  it('opens by name, grabs at the camera size, closes the old camera on reopen', async () => {
    const { h, log } = host()
    const cam = new CamDevice(parseUseUrl('cam://Payphone')!, { host: () => h, cameraAccess: async () => 'granted' })
    expect(await cam.open()).toEqual({ width: 1280, height: 720 })
    expect(await cam.capture()).toEqual({ jpeg: 'J', points: { width: 1280, height: 720 } })
    expect(cam.title()).toBe('Payphone 2-dollar Camera')
    await cam.open()
    await cam.close()
    expect(log).toEqual(['open Payphone', 'grab k1', 'close k1', 'open Payphone', 'close k2'])
    expect('perform' in cam).toBe(false)
  })

  it('refuses in words when the camera grant is off, and never touches the host', async () => {
    const { h, log } = host()
    const cam = new CamDevice(parseUseUrl('cam://0')!, { host: () => h, cameraAccess: async () => 'denied' })
    await expect(cam.open()).rejects.toThrow(CAMERA_OFF)
    await expect(cam.capture()).rejects.toThrow(/not open/)
    expect(log).toEqual([])
  })

  it('while the macOS dialog is up it says to answer it, and goes on once granted', async () => {
    const { h } = host()
    let access: 'asking' | 'granted' = 'asking'
    const cam = new CamDevice(parseUseUrl('cam://0')!, { host: () => h, cameraAccess: async () => access })
    await expect(cam.open()).rejects.toThrow(CAMERA_ASKING)
    access = 'granted'
    expect(await cam.open()).toEqual({ width: 1280, height: 720 })
  })
})
