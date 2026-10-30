// WHAT A USE LOOKS LIKE WHILE IT HAPPENS (shared/use-signal.ts): the signal's
// shape, where a point sits, and which tool calls are uses at all.
import { describe, expect, it } from 'vitest'
import { isUseSignal, useFraction, useOfToolCall, useOfToolLine } from '../src/shared/use-signal'

const good = { agent: 't1', card: 'b1', use: 'phone', verb: 'tap', point: { x: 100, y: 200 }, viewport: { width: 400, height: 800 }, at: 1 }

describe('isUseSignal', () => {
  it('admits the shape the engine mints, with or without a point', () => {
    expect(isUseSignal(good)).toBe(true)
    expect(isUseSignal({ ...good, point: null, viewport: null })).toBe(true)
  })
  it('refuses a stranger', () => {
    expect(isUseSignal({ ...good, use: 'teleport' })).toBe(false)
    expect(isUseSignal({ ...good, verb: 'Drop Table' })).toBe(false)
    expect(isUseSignal({ ...good, agent: '' })).toBe(false)
    expect(isUseSignal({ ...good, point: { x: Number.NaN, y: 1 } })).toBe(false)
    expect(isUseSignal({ ...good, viewport: { width: 0, height: 10 } })).toBe(false)
    expect(isUseSignal(null)).toBe(false)
  })
})

describe('useFraction', () => {
  it('is the point over the viewport, clamped to the screen', () => {
    expect(useFraction(good)).toEqual({ x: 0.25, y: 0.25 })
    expect(useFraction({ point: { x: 900, y: -5 }, viewport: { width: 400, height: 800 } })).toEqual({ x: 1, y: 0 })
    expect(useFraction({ point: null, viewport: null })).toBeNull()
  })
})

describe('useOfToolCall', () => {
  it('names the use of the tools agents reach resources with', () => {
    expect(useOfToolCall('mcp__claude-in-chrome__navigate', '')).toEqual({ use: 'browser', via: 'chrome' })
    expect(useOfToolCall('mcp__computer-use__click', '')).toEqual({ use: 'computer', via: 'computer' })
    expect(useOfToolCall('Bash', 'adb -s R58 shell input tap 10 20')).toEqual({ use: 'phone', via: 'adb' })
    expect(useOfToolCall('Bash', 'cd fw && esptool.py --port /dev/cu.usbserial-1 write_flash 0x0 a.bin')).toEqual({ use: 'hardware', via: 'flash' })
    expect(useOfToolCall('Bash', 'picocom -b 115200 /dev/tty.usbmodem1')).toEqual({ use: 'hardware', via: 'serial' })
    expect(useOfToolCall('Bash', 'xcrun simctl io booted screenshot a.png')).toEqual({ use: 'phone', via: 'ios' })
    expect(useOfToolCall('Bash', 'cookrew browser tap "Pixel" 10 20')).toEqual({ use: 'browser', via: 'browser' })
    expect(useOfToolCall('exec_command', 'screencapture -x a.png')).toEqual({ use: 'computer', via: 'mac' })
  })
  it('is null for ordinary work, including commands that only MENTION a tool', () => {
    expect(useOfToolCall('Read', '/src/adb.ts')).toBeNull()
    expect(useOfToolCall('Bash', 'npm test')).toBeNull()
    expect(useOfToolCall('Bash', 'rg "adb shell" src')).toBeNull()
    expect(useOfToolCall('Bash', 'git commit -m "esptool notes"')).toBeNull()
  })
})

describe('useOfToolLine', () => {
  it('reads the tool line an agent terminal shows', () => {
    expect(useOfToolLine('Bash(adb shell input tap 540 1200)')).toEqual({ use: 'phone', via: 'adb' })
    expect(useOfToolLine('claude-in-chrome - computer (MCP)(action: "left_click")')).toEqual({ use: 'browser', via: 'chrome' })
    expect(useOfToolLine('Ran arduino-cli upload -p /dev/cu.usbmodem1')).toEqual({ use: 'hardware', via: 'flash' })
    expect(useOfToolLine('Read(src/main/index.ts)')).toBeNull()
    expect(useOfToolLine('Thinking…')).toBeNull()
  })
})
