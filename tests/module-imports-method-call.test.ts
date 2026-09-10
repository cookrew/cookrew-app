import { describe, expect, it } from 'vitest'
import { parseImportEdges } from './support/module-imports'

// The grant sweep BLOCKS on a dynamic `import(expr)` it cannot resolve, which
// is the right refusal — and it must not be handed one by a METHOD that
// happens to be called `import`. `serve.import(link)` is the served-team
// importer; the word boundary alone let the `.` before it through and kept
// the sweep red on dev for four days (2026-09-05 → 09-09).

describe('parseImportEdges — a method named import is not the import operator', () => {
  it('ignores member calls named import or require', () => {
    const edges = parseImportEdges(`
      const answer = await deps.serve.import(link, position, paid)
      serveOps.import(link)
      registry.require(name)
      const $import = 1
    `)
    expect(edges).toEqual([])
  })

  it('ignores a method DECLARED as import — interface signature or class body', () => {
    const edges = parseImportEdges(`
      export interface ServeOps {
        import(
          link: string,
          position?: { x: number; y: number },
        ): Promise<unknown>;
      }
      class Ops {
        async import(link: string) {
          return link
        }
      }
    `)
    expect(edges).toEqual([])
  })

  it('still sees a real dynamic import, literal or computed', () => {
    const edges = parseImportEdges(`
      const a = await import('./storage-gc-worker')
      const b = await import(workerFile)
      const c = require('./pty')
    `)
    expect(edges.map((e) => [e.specifier, e.computed])).toEqual([
      ['./storage-gc-worker', false],
      [null, true],
      ['./pty', false]
    ])
  })
})
