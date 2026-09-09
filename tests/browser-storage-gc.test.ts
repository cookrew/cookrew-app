import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REGENERABLE_PROFILE_DIRS,
  purgeRegenerableProfileData,
  reapOrphanPartitions,
  partitionIdOf
} from '../src/main/browser-storage-gc'

function tree(base: string, rels: string[]): void {
  for (const rel of rels) {
    const full = path.join(base, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, 'x'.repeat(64))
  }
}

const root = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-bgc-'))

describe('partitionIdOf — the name a canvas webview partition carries', () => {
  it('reads the node id out of the browser- prefix', () => {
    expect(partitionIdOf('browser-abc-123')).toBe('abc-123')
  })

  it('answers null for anything not shaped like a browser partition', () => {
    // Electron keeps unrelated partitions in the same directory. A reaper that
    // guessed here would delete storage belonging to another feature.
    expect(partitionIdOf('abc-123')).toBeNull()
    expect(partitionIdOf('persist%3Asomething')).toBeNull()
    expect(partitionIdOf('browser-')).toBeNull()
  })
})

describe('reapOrphanPartitions — the store that never had a reaper', () => {
  it('removes a partition whose browser card is gone', () => {
    const dir = root()
    tree(dir, ['browser-dead/Local Storage/leveldb/x.log'])
    const removed = reapOrphanPartitions(dir, [])
    expect(removed).toEqual(['browser-dead'])
    expect(existsSync(path.join(dir, 'browser-dead'))).toBe(false)
  })

  it('keeps a partition whose card is still on a canvas', () => {
    const dir = root()
    tree(dir, ['browser-live/Cookies'])
    expect(reapOrphanPartitions(dir, ['live'])).toEqual([])
    expect(existsSync(path.join(dir, 'browser-live'))).toBe(true)
  })

  it('never touches a directory it cannot name', () => {
    const dir = root()
    tree(dir, ['some-other-feature/data'])
    expect(reapOrphanPartitions(dir, [])).toEqual([])
    expect(existsSync(path.join(dir, 'some-other-feature'))).toBe(true)
  })

  it('a missing root reaps nothing rather than throwing', () => {
    expect(reapOrphanPartitions(path.join(root(), 'nope'), [])).toEqual([])
  })
})

describe('purgeRegenerableProfileData — Chrome ignores the flags, so delete it', () => {
  it('removes the component and model stores', () => {
    const dir = root()
    tree(dir, [
      'optimization_guide_model_store/model.bin',
      'component_crx_cache/a.crx',
      'WasmTtsEngine/voice.wasm',
      'Default/Service Worker/x.js'
    ])
    const freed = purgeRegenerableProfileData(dir)
    expect(freed).toBeGreaterThan(0)
    expect(existsSync(path.join(dir, 'optimization_guide_model_store'))).toBe(false)
    expect(existsSync(path.join(dir, 'Default/Service Worker'))).toBe(false)
  })

  it('KEEPS cookies, logins and site storage', () => {
    // The whole point of a per-card profile is that a site stays logged in.
    // Purging is only allowed to cost a re-download, never a re-login.
    const dir = root()
    tree(dir, [
      'Default/Cookies',
      'Default/Local Storage/leveldb/x.log',
      'Default/IndexedDB/site/x.db',
      'Default/Preferences',
      'optimization_guide_model_store/model.bin'
    ])
    purgeRegenerableProfileData(dir)
    for (const kept of [
      'Default/Cookies',
      'Default/Local Storage/leveldb/x.log',
      'Default/IndexedDB/site/x.db',
      'Default/Preferences'
    ]) {
      expect(existsSync(path.join(dir, kept))).toBe(true)
    }
  })

  it('is idempotent and safe on a profile that has none of them', () => {
    const dir = root()
    tree(dir, ['Default/Cookies'])
    expect(purgeRegenerableProfileData(dir)).toBe(0)
    expect(purgeRegenerableProfileData(dir)).toBe(0)
  })

  it('never lists a site-state directory as regenerable', () => {
    for (const rel of REGENERABLE_PROFILE_DIRS) {
      expect(rel).not.toMatch(/Cookies|Local Storage|IndexedDB|Preferences|Login Data/)
    }
  })
})
