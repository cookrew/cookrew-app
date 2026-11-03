// THE DESKTOP HAS NO LEVELS (owner, 2026-10-31: "delete the levels code").
// The Levels view, the stage's devices and workspaces levels, the levels path
// in the header and the desktop's levels feed are gone. What stays is what
// cookrew.dev uses: /api/levels (the /me page reads every desktop through it),
// its service in src/main/levels, and src/strata.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('the desktop app', () => {
  it('has no levels view, levels feed or levels path', () => {
    expect(existsSync('src/renderer/src/levels')).toBe(false)
    expect(existsSync('src/renderer/src/stage/StageMap.tsx')).toBe(false)
    for (const file of ['src/renderer/src/App.tsx', 'src/renderer/src/api.ts', 'src/renderer/src/remote-api.ts', 'src/renderer/src/demo-api.ts', 'src/preload/index.ts']) {
      const text = read(file)
      expect(text, file).not.toMatch(/subscribeLevels|getLevelsAgent|LevelsView/)
    }
    expect(read('src/main/index.ts')).not.toMatch(/'levels:(subscribe|unsubscribe|detail)'/)
  })
})

describe('what cookrew.dev still reads', () => {
  it('keeps /api/levels on the companion server, for /me and the embed', () => {
    const server = read('src/main/mobile-server.ts')
    expect(server).toContain("import { handleLevelsRoutes } from './levels/routes'")
    expect(server).toMatch(/handleLevelsRoutes\(/)
    expect(read('src/renderer/src/embed/embed-boot.ts')).toContain('/api/levels/agents/')
  })
})
