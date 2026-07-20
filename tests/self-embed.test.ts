import { describe, expect, it } from 'vitest'
import { isSelfEmbedding } from '../src/renderer/src/self-embed'

describe('isSelfEmbedding', () => {
  it('blocks the mobile companion ports on any host', () => {
    expect(isSelfEmbedding('http://192.168.2.13:8639/', 'file://')).toBe(true)
    expect(isSelfEmbedding('https://192.168.2.13:8643/', 'file://')).toBe(true)
    expect(isSelfEmbedding('http://localhost:8639/x', 'file://')).toBe(true)
  })

  it('blocks the app own origin (dev server in dev builds)', () => {
    expect(isSelfEmbedding('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
  })

  it('allows normal sites, including other localhost dev servers', () => {
    expect(isSelfEmbedding('https://cookrew.dev/', 'http://localhost:5173')).toBe(false)
    expect(isSelfEmbedding('http://localhost:3000/', 'http://localhost:5173')).toBe(false)
    // A packaged app (file:// origin) must not block a user's OWN vite app.
    expect(isSelfEmbedding('http://localhost:5173/', 'file://')).toBe(false)
  })

  it('leaves unparseable URLs to the webview', () => {
    expect(isSelfEmbedding('not a url', 'http://localhost:5173')).toBe(false)
  })
})
