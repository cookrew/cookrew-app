// THE DESKTOP HAS NO LEVELS (owner, 2026-10-31: "delete the levels code").
// The Levels view, the stage's devices and workspaces levels, the levels path
// in the header and the desktop's levels feed are gone, and so is the cookrew.dev
// shell they fed (owner, 2026-11-05). What stays is /api/levels and its service
// in src/main/levels: the zoom view reads every other device through them.
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

describe('the shell is gone', () => {
  it('leaves no shell, embed or agent detail behind', () => {
    expect(existsSync('src/strata')).toBe(false)
    expect(existsSync('src/renderer/src/embed')).toBe(false)
    expect(existsSync('registry/src/strata-shell.ts')).toBe(false)
    expect(read('src/main/levels/routes.ts')).not.toContain('/api/levels/agents')
  })
})

describe('what the zoom view still reads', () => {
  it('keeps /api/levels on the companion server', () => {
    const server = read('src/main/mobile-server.ts')
    expect(server).toContain("import { handleLevelsRoutes } from './levels/routes'")
    expect(server).toMatch(/handleLevelsRoutes\(/)
  })
})
