import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')

describe('transcript content-visibility scope', () => {
  it('keeps deferred block paint on mobile without blanking the desktop transcript', () => {
    expect(css).toMatch(
      /body\.cookrew-mobile \.ctx-block,\s*body\.cookrew-mobile \.ctx-placeholder\s*\{[^}]*content-visibility:\s*auto/s,
    )
    expect(css).not.toMatch(/\n\.ctx-block,\s*\n\.ctx-placeholder\s*\{[^}]*content-visibility/s)
  })
})
