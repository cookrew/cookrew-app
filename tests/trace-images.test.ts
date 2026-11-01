// CLAUDE CODE'S OWN PASTED IMAGES IN A TURN (owner, 2026-11-01: draw them in
// CHAT and LOG). A prompt pasted with a screenshot is recorded as "[Image #N]"
// in its words and an image block beside them; the block says WHERE the
// bytes are (record uuid, block position) and never carries them.

import { describe, expect, it } from 'vitest'
import { parseClaudeTrace } from '../src/shared/trace-blocks'

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry)
const PIXELS = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }

describe('a Claude prompt with pasted images', () => {
  it('the block names each image by its record and position, with Claude’s number', () => {
    const [block] = parseClaudeTrace([
      line({ type: 'user', uuid: 'u1', timestamp: '2026-11-01T00:00:00Z', imagePasteIds: [3, 4], message: { role: 'user', content: [{ type: 'text', text: '[Image #3] [Image #4] which is better?' }, PIXELS, PIXELS] } })
    ])
    expect(block.prompt).toBe('[Image #3] [Image #4] which is better?')
    expect(block.images).toEqual([
      { uuid: 'u1', i: 1, n: 3 },
      { uuid: 'u1', i: 2, n: 4 }
    ])
    expect(JSON.stringify(block)).not.toContain('iVBORw0KGgo')
  })

  it('the record of the same submission that carries the images adds them to the block', () => {
    const blocks = parseClaudeTrace([
      line({ type: 'user', uuid: 'u1', parentUuid: 'p0', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: '[Image #1] look' } }),
      line({ type: 'user', uuid: 'u2', parentUuid: 'p0', timestamp: '2026-11-01T00:00:00Z', imagePasteIds: [1], message: { role: 'user', content: [{ type: 'text', text: '[Image #1] look' }, PIXELS] } })
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].images).toEqual([{ uuid: 'u2', i: 1, n: 1 }])
  })

  it('a prompt without pictures carries no images at all, and a tool’s picture is not the prompt’s', () => {
    const blocks = parseClaudeTrace([
      line({ type: 'user', uuid: 'u1', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'plain words' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-01T00:00:01Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x.png' } }] } }),
      line({ type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: '2026-11-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [PIXELS] }] } })
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).not.toHaveProperty('images')
  })
})
