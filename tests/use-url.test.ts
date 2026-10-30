// EVERY USE IS A CARD ADDRESS (shared/use-url.ts): the grammar, its inverse,
// and the addresses it refuses.
import { describe, expect, it } from 'vitest'
import { isUseUrl, parseRoi, parseUseUrl, useUrl } from '../src/shared/use-url'

describe('parseUseUrl', () => {
  it('reads each use and the use it is', () => {
    expect(parseUseUrl('screen://main')).toEqual({ kind: 'screen', use: 'computer', name: 'main', detail: null, roi: null })
    expect(parseUseUrl('screen://2?roi=0,0,800,600')).toMatchObject({ kind: 'screen', name: '2', roi: { x: 0, y: 0, width: 800, height: 600 } })
    expect(parseUseUrl('window://Safari')).toMatchObject({ kind: 'window', use: 'computer', name: 'Safari', detail: null })
    expect(parseUseUrl('window://Simulator/iPhone%2017%20Pro')).toMatchObject({ name: 'Simulator', detail: 'iPhone 17 Pro' })
    expect(parseUseUrl('adb://emulator-5554')).toMatchObject({ kind: 'adb', use: 'phone', name: 'emulator-5554' })
    expect(parseUseUrl('adb://default')).toMatchObject({ kind: 'adb', name: 'default' })
    expect(parseUseUrl('cam://0')).toMatchObject({ kind: 'cam', use: 'hardware', name: '0' })
    expect(parseUseUrl('cam://Payphone')).toMatchObject({ kind: 'cam', name: 'Payphone' })
    expect(parseUseUrl('vphone://myphone/com.apple.Preferences')).toEqual({
      kind: 'vphone',
      use: 'phone',
      name: 'myphone',
      detail: 'com.apple.Preferences',
      roi: null
    })
  })

  it('is not a use for a web address, and refuses what is malformed', () => {
    for (const url of [
      'https://example.com',
      'about:blank',
      'screen://',
      'screen://../etc',
      'adb://a/b',
      'cam://0?roi=0,0,100,100',
      'screen://main?roi=1,2,3',
      'screen://main?roi=0,0,8,8',
      'screen://main?roi=0,0,99999,10',
      'window://%E0%A4%A',
      'vphone://../x'
    ]) {
      expect(parseUseUrl(url), url).toBeNull()
      expect(isUseUrl(url), url).toBe(false)
    }
  })

  it('prints an address that reads back as itself', () => {
    for (const url of ['screen://main', 'screen://2?roi=10,20,300,400', 'window://Simulator/iPhone%2017', 'adb://R58M12', 'cam://0']) {
      const target = parseUseUrl(url)
      expect(target).not.toBeNull()
      expect(parseUseUrl(useUrl(target!))).toEqual(target)
    }
  })

  it('roi is four whole non-negative numbers, at least 16 points a side', () => {
    expect(parseRoi(null)).toBeNull()
    expect(parseRoi('0,0,16,16')).toEqual({ x: 0, y: 0, width: 16, height: 16 })
    expect(parseRoi('0,0,15,16')).toBeUndefined()
    expect(parseRoi('-1,0,100,100')).toBeUndefined()
    expect(parseRoi('0.5,0,100,100')).toBeUndefined()
  })
})
