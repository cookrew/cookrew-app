// A slug is a workspace's URL identity: https://<host>/<slug>. Commander's
// ruling (marketplace §11, 2026-08-20) is derive-and-FREEZE — minted once at
// creation from the name, never recomputed. What is pinned here is that
// freeze: a rename must not move a phone's bookmark, because the bookmark is
// the only thing a paired device has.

import { describe, expect, it } from 'vitest'
import { deriveSlug, uniqueSlug, slugFor } from '../src/main/workspace-slug'

describe('deriveSlug', () => {
  it('lowercases and hyphenates ordinary names', () => {
    expect(deriveSlug('Cookrew Dev')).toBe('cookrew-dev')
    expect(deriveSlug('Playground')).toBe('playground')
  })

  it('collapses runs of separators and trims the edges', () => {
    expect(deriveSlug('  My   Big -- Project  ')).toBe('my-big-project')
    expect(deriveSlug('---edge---')).toBe('edge')
  })

  it('drops characters that have meaning in a URL path', () => {
    expect(deriveSlug('a/b?c#d')).toBe('a-b-c-d')
    expect(deriveSlug('100% Done!')).toBe('100-done')
  })

  it('keeps emoji and non-ASCII out of the path', () => {
    expect(deriveSlug('🗂 Notes')).toBe('notes')
    expect(deriveSlug('café')).toBe('caf')
  })

  it('falls back rather than returning an empty path segment', () => {
    // A name of pure punctuation/emoji still needs an addressable route.
    expect(deriveSlug('🗂')).toBe('workspace')
    expect(deriveSlug('///')).toBe('workspace')
    expect(deriveSlug('')).toBe('workspace')
  })

  it('never collides with the route prefixes the server already owns', () => {
    // /api/* and /assets/* are mounted by mobile-server; a workspace slug that
    // shadowed them would make its own routes unreachable.
    expect(deriveSlug('api')).toBe('api-ws')
    expect(deriveSlug('API')).toBe('api-ws')
    expect(deriveSlug('assets')).toBe('assets-ws')
  })

  it('bounds the length so a slug stays a usable path segment', () => {
    const slug = deriveSlug('x'.repeat(200))
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('uniqueSlug', () => {
  it('returns the base when nothing holds it', () => {
    expect(uniqueSlug('playground', [])).toBe('playground')
  })

  it('suffixes -2 on collision, per the approved ruling', () => {
    expect(uniqueSlug('playground', ['playground'])).toBe('playground-2')
  })

  it('keeps counting past an existing suffix', () => {
    expect(uniqueSlug('playground', ['playground', 'playground-2'])).toBe('playground-3')
  })

  it('does not treat a longer slug as a collision', () => {
    expect(uniqueSlug('play', ['playground'])).toBe('play')
  })
})

describe('slugFor', () => {
  it('mints from the name when a workspace has none', () => {
    expect(slugFor({ name: 'Cookrew Dev' }, [])).toBe('cookrew-dev')
  })

  it('FREEZES: an existing slug survives a rename', () => {
    // The whole point of the ruling. The meta says 'Renamed Thing' but the
    // slug was minted as 'cookrew-dev' — the phone bookmark must still work.
    expect(slugFor({ name: 'Renamed Thing', slug: 'cookrew-dev' }, [])).toBe('cookrew-dev')
  })

  it('keeps a frozen slug even when it would now collide', () => {
    // Taken-ness is resolved at MINT time only. Re-uniquing here would move a
    // live route out from under paired devices — exactly what freeze forbids.
    expect(slugFor({ name: 'X', slug: 'cookrew-dev' }, ['cookrew-dev'])).toBe('cookrew-dev')
  })

  it('uniques against taken slugs when minting', () => {
    expect(slugFor({ name: 'Cookrew Dev' }, ['cookrew-dev'])).toBe('cookrew-dev-2')
  })

  it('ignores a blank stored slug and re-mints', () => {
    expect(slugFor({ name: 'Cookrew Dev', slug: '' }, [])).toBe('cookrew-dev')
  })
})
