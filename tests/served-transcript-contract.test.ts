import { describe, expect, it } from 'vitest'
import { SERVED_TRANSCRIPT_PATHS } from '../src/shared/served-transcript'

describe('served transcript route contract', () => {
  it('exposes only caller-scoped paths with no selectable session identity', () => {
    expect(SERVED_TRANSCRIPT_PATHS).toEqual({
      turns: '/turns',
      trace: '/trace',
      traceIndex: '/trace/index',
      traceMarkers: '/trace/markers'
    })
    expect(
      Object.values(SERVED_TRANSCRIPT_PATHS).every((path) => !/session|terminal/.test(path))
    ).toBe(true)
  })
})
