// A VIRTUAL iPHONE IS A BROWSER CARD WHOSE URL NAMES A MACHINE.
//
// `vphone://<machine>` is the whole address; an optional path names the app
// to launch. The scheme is what tells the manager to back the card with a
// vphone instance instead of a headless Chrome, and what tells the renderer
// never to hand the URL to a <webview> or an <iframe>.
import { describe, expect, it } from 'vitest'
import { isVphoneUrl, parseVphoneUrl, vphoneUrl } from '../src/shared/vphone-url'

describe('parseVphoneUrl', () => {
  it('reads the machine, and the app when one is named', () => {
    expect(parseVphoneUrl('vphone://myphone')).toEqual({ machine: 'myphone', app: null })
    expect(parseVphoneUrl('vphone://myphone/')).toEqual({ machine: 'myphone', app: null })
    expect(parseVphoneUrl('vphone://my-phone_2/com.apple.Preferences')).toEqual({
      machine: 'my-phone_2',
      app: 'com.apple.Preferences'
    })
    expect(parseVphoneUrl('VPHONE://MyPhone')).toEqual({ machine: 'MyPhone', app: null })
  })

  it('refuses anything that is not a machine name', () => {
    for (const bad of ['', 'vphone://', 'vphone:///x', 'vphone://../etc', 'vphone://a b', 'https://vphone', 'vphone://x/y/z', `vphone://${'a'.repeat(80)}`]) {
      expect(parseVphoneUrl(bad), bad).toBeNull()
    }
  })

  it('round-trips through vphoneUrl', () => {
    expect(vphoneUrl('myphone')).toBe('vphone://myphone')
    expect(vphoneUrl('myphone', 'com.apple.mobilesafari')).toBe('vphone://myphone/com.apple.mobilesafari')
    expect(isVphoneUrl('vphone://myphone')).toBe(true)
    expect(isVphoneUrl('https://example.test')).toBe(false)
  })
})
