// AN ANDROID DEVICE OVER ADB (main/adb-device.ts): what it reads from adb,
// and what each gesture becomes on the device's own command line.
import { describe, expect, it } from 'vitest'
import { AdbDevice, adbKeyCode, deviceQuote, inputText, parseDensity, parseWmSize, pickDevice, pngSize } from '../src/main/adb-device'
import { parseUseUrl } from '../src/shared/use-url'

const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(24)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

describe('reading adb', () => {
  it('sizes, density and the PNG header', () => {
    expect(parseWmSize('Physical size: 1080x2400\n')).toEqual({ width: 1080, height: 2400 })
    expect(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n')).toEqual({ width: 720, height: 1600 })
    expect(parseDensity('Physical density: 420\n')).toBeCloseTo(2.625)
    expect(parseDensity('nothing')).toBeNull()
    expect(pngSize(png(1080, 2400))).toEqual({ width: 1080, height: 2400 })
    expect(pngSize(Buffer.from('not a png at all, no sir'))).toBeNull()
  })

  it('picks the one device, or says why there is not one', () => {
    expect(pickDevice('List of devices attached\nR58M device\n\n')).toBe('R58M')
    expect(() => pickDevice('List of devices attached\n\n')).toThrow(/No Android device is attached/)
    expect(() => pickDevice('List of devices attached\nA device\nB device\n')).toThrow(/2 Android devices.*adb:\/\/<serial>/)
    expect(() => pickDevice('List of devices attached\nR58M unauthorized\n')).toThrow(/accept the USB debugging prompt/)
  })

  it('quotes for the device shell and for input text', () => {
    expect(deviceQuote("it's")).toBe(`'it'\\''s'`)
    expect(inputText('50% off now')).toBe('50%%%soff%snow')
    expect(adbKeyCode('return')).toBe(66)
    expect(adbKeyCode('escape')).toBe(4)
    expect(adbKeyCode('f13')).toBeNull()
  })
})

describe('AdbDevice', () => {
  function bed() {
    const calls: string[][] = []
    const device = new AdbDevice(parseUseUrl('adb://default')!, {
      run: async (args) => {
        calls.push([...args])
        const joined = args.join(' ')
        if (joined === 'devices') return Buffer.from('List of devices attached\nR58M device\n')
        if (joined.endsWith('wm size')) return Buffer.from('Physical size: 1080x2400\n')
        if (joined.endsWith('wm density')) return Buffer.from('Physical density: 420\n')
        if (joined.endsWith('screencap -p')) return png(2400, 1080)
        return Buffer.alloc(0)
      },
      toJpeg: () => Buffer.from('jpeg')
    })
    return { calls, device }
  }

  it('opens in density points, and a rotated frame reports landscape points', async () => {
    const { device } = bed()
    expect(await device.open()).toEqual({ width: 411, height: 914 })
    const frame = await device.capture()
    expect(frame.points).toEqual({ width: 914, height: 411 })
    expect(frame.jpeg).toBe(Buffer.from('jpeg').toString('base64'))
  })

  it('turns each gesture into the device command, in pixels, against the chosen serial', async () => {
    const { calls, device } = bed()
    await device.open()
    calls.length = 0
    await device.perform({ method: 'input.tap', params: { x: 100, y: 200 } })
    await device.perform({ method: 'input.swipe', params: { x1: 10, y1: 400, x2: 10, y2: 100, seconds: 0.25 } })
    await device.perform({ method: 'input.key', params: { name: 'return' } })
    await device.perform({ method: 'input.type', params: { text: "it's here" } })
    expect(calls).toEqual([
      ['-s', 'R58M', 'shell', 'input', 'tap', '263', '525'],
      ['-s', 'R58M', 'shell', 'input', 'swipe', '26', '1050', '26', '263', '250'],
      ['-s', 'R58M', 'shell', 'input', 'keyevent', '66'],
      ['-s', 'R58M', 'shell', 'input', 'text', `'it'\\''s%shere'`]
    ])
    await expect(device.perform({ method: 'input.paste', params: { text: '你好' } })).rejects.toThrow(/ASCII only/)
    await expect(device.navigate('file:///etc/passwd')).rejects.toThrow(/Only http/)
  })
})
