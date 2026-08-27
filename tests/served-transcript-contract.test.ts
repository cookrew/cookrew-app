import { describe, expect, it } from 'vitest'
import {
  SERVED_TRANSCRIPT_PATHS,
  type ServedRemoteTurnSource
} from '../src/shared/served-transcript'

describe('served remote turn source contract', () => {
  it('exposes only caller-scoped paths with no selectable session identity', () => {
    expect(SERVED_TRANSCRIPT_PATHS).toEqual({
      turns: '/turns',
      trace: '/trace',
      traceIndex: '/trace/index',
      traceMarkers: '/trace/markers'
    })
    expect(Object.values(SERVED_TRANSCRIPT_PATHS).every((path) => !/session|terminal/.test(path))).toBe(true)
  })

  it('matches the normal transcript capability without a terminalId argument', async () => {
    const source: ServedRemoteTurnSource = {
      listTurns: async () => ({ turns: [], total: 0, offset: 0 }),
      listTrace: async () => ({ blocks: [], total: 0, source: null }),
      listTraceIndex: async () => [],
      listTraceMarkers: async () => []
    }
    await expect(source.listTurns({ limit: 20 })).resolves.toEqual({
      turns: [],
      total: 0,
      offset: 0
    })
  })
})
