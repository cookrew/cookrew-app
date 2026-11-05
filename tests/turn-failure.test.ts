import { describe, expect, it } from 'vitest'
import { inkStatusOfRow, statusWord } from '../src/renderer/src/zoom/ink-status'
import { cleanTurnLines } from '../src/shared/turn'
import { turnFailure } from '../src/shared/turn-failure'
import { cleanModelName } from '../src/renderer/src/zoom-bar'

/**
 * A REFUSED TURN IS NOT A DONE TURN (C-3): a provider's 400 ended as done, then
 * RESTING, with the error text sitting on the card. Read off what each harness
 * prints when a request fails.
 */

describe('what counts as a failed turn', () => {
  it.each([
    ['API Error: 400 Unable to generate parser for this template'],
    ['API Error: 401 {"type":"error"}'],
    ['  API Error (500 Internal Server Error)'],
    ['stream error: unexpected status 400 Bad Request'],
    ['■ unexpected status 401 Unauthorized'],
    ['Error: 429 rate limited']
  ])('%s', (reply) => {
    expect(turnFailure({ reply, lines: [] })).toContain(reply.trim().slice(0, 12))
  })

  it.each([['API error handling is fixed'], ['## Error 404 page added'], ['Error 500 pages now render'], ['Stream error handling works now'], ['API Errors are logged']])('a good reply is not one: %s', (reply) => {
    expect(turnFailure({ reply, lines: [] })).toBeNull()
  })

  it('reads the last words on screen when no reply was parsed', () => {
    expect(turnFailure({ reply: null, lines: ['something', 'API Error: 400 nope'] })).toContain('API Error: 400')
  })

  it('leaves a reply that talks about errors alone', () => {
    expect(turnFailure({ reply: 'Fixed the API Error: 400 you saw in the logs.', lines: [] })).toBeNull()
    expect(turnFailure({ reply: 'The tests pass now.', lines: ['Error: 400 was in an old log'] })).toBeNull()
    expect(turnFailure({ reply: null, lines: [] })).toBeNull()
  })
})

describe('what the card says', () => {
  it('has a word and a face of its own', () => {
    expect(inkStatusOfRow('failed')).toBe('failed')
    expect(statusWord('failed')).toBe('failed')
  })
})

describe('the model a harness reports (C-8)', () => {
  it('hides a placeholder: <synthetic> is what a refused turn records', () => {
    expect(cleanModelName('<synthetic>')).toBeNull()
    expect(cleanModelName('qwen3.8-27b-q8')).toBe('qwen3.8-27b-q8')
    expect(cleanModelName(null)).toBeNull()
  })
})

describe('a harness’s own timing line (C-8)', () => {
  it('is not the agent’s words', () => {
    expect(cleanTurnLines('Took 0.0s\nThe tests pass.')).toEqual(['The tests pass.'])
    expect(cleanTurnLines('Took a while to find it')).toEqual(['Took a while to find it'])
  })
})
