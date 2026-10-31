// THE PAINTER'S ELEMENTS ARE COLLECTED WHEN THEY CHANGE, NOT EVERY FRAME (perf,
// 2026-11-01: collect read three offsetWidths per agent and rebuilt five maps
// on every animation frame, 158 ms in 12 s of zooming).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const view = readFileSync(path.join(__dirname, '..', 'src/renderer/src/zoom/ZoomView.tsx'), 'utf8')

describe("the zoom view's collect", () => {
  it('returns the last result while the model, the registered elements and the fonts are the same', () => {
    expect(view).toContain('last.model === modelRef.current && last.registry === registryVersion.current && last.fonts === fontsVersion.current')
  })

  it('counts an element joining or leaving, and not a ref that re-binds the same element', () => {
    const bind = view.slice(view.indexOf('const bind = useCallback'), view.indexOf('const zoom = useZoom()'))
    expect(bind).toContain('if (registry.current.get(key) === el) return')
    expect(bind).toContain('registryVersion.current += 1')
  })

  it('measures again when a web font lands, and wakes the painter', () => {
    expect(view).toMatch(/fonts\.addEventListener\('loadingdone', onFonts\)/)
    expect(view).toMatch(/fontsVersion\.current \+= 1\s*motion\.wake\(\)/)
  })
})
