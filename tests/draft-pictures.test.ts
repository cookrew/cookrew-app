// THE BOX SHOWS THE PICTURE, NOT ITS PATH (owner, 2026-11-02: the prompt box
// showed the screenshot AND its path). The draft keeps the path, at the end,
// for the agent to read; the box shows the words and edits them in place.

import { describe, expect, it } from 'vitest'
import {
  draftOf,
  pictureTokens,
  shownWords,
  withoutLastPicture,
  withoutPicture,
  withPictures,
  withShownWords
} from '../src/renderer/src/prompt/draft-pictures'
import { mentionTarget } from '../src/renderer/src/prompt/prompt-target'
import { lineTextFor } from '../src/renderer/src/prompt/live-line'

const A = '/Users/me/.cookrew/attachments/a.png'
const B = '/Users/me/.cookrew/attachments/b.png'

describe('the box shows the words, the draft carries the paths', () => {
  it('a dropped screenshot goes to the end of the draft and shows as no words', () => {
    expect(withPictures('', [A])).toBe(A)
    expect(shownWords(withPictures('', [A]))).toBe('')
    expect(withPictures('fix this', [A, B])).toBe(`fix this ${A} ${B}`)
    expect(shownWords(`fix this ${A} ${B}`)).toBe('fix this')
  })

  it('whatever is typed, the box gets exactly those words back: the caret never jumps', () => {
    for (const words of ['', ' ', 'h', 'hi ', ' x', 'a  b', '@Other look', '#No']) {
      expect(shownWords(withShownWords(`old ${A} ${B}`, words))).toBe(words)
      expect(pictureTokens(withShownWords(`old ${A} ${B}`, words))).toEqual([A, B])
    }
  })

  it('a path elsewhere in the draft (typed in LIVE) is hidden too, and goes to the end on an edit', () => {
    expect(shownWords(`look ${A} please`)).toBe('look please')
    expect(shownWords(`${A} please`)).toBe('please')
    expect(withShownWords(`look ${A} please`, 'look please!')).toBe(`look please! ${A}`)
  })

  it('an escaped path stays escaped for the agent, and a path added twice is carried once', () => {
    const spaced = withPictures('', ['/x/Screen Shot.png'])
    expect(spaced).toBe('/x/Screen\\ Shot.png')
    expect(shownWords(spaced)).toBe('')
    expect(withPictures(`hi ${A}`, [A])).toBe(`hi ${A}`)
    expect(withPictures('hi', [''])).toBe('hi')
  })

  it('× takes one picture out; Backspace in an empty box takes the last', () => {
    expect(withoutPicture(`hi ${A} ${B}`, A)).toBe(`hi ${B}`)
    expect(withoutPicture('hi /x/Screen\\ Shot.png', '/x/Screen Shot.png')).toBe('hi')
    expect(withoutLastPicture(`${A} ${B}`)).toBe(A)
    expect(withoutLastPicture(A)).toBe('')
  })

  it('no pictures: the draft is the words, untouched', () => {
    expect(draftOf('just words ', [])).toBe('just words ')
    expect(shownWords('just words ')).toBe('just words ')
  })
})

describe('with a picture in the draft', () => {
  const agents = [{ id: 'o', name: 'Other' }]

  it('"@Other …" still leads the draft, and the picture goes to Other with the words', () => {
    const draft = withShownWords(withPictures('', [A]), '@Other look')
    expect(mentionTarget(draft, agents)).toEqual({ id: 'o', text: `look ${A}` })
  })

  it('a name still being typed waits, as it does without a picture', () => {
    expect(lineTextFor(withShownWords(A, '@Ot'), 'me', null, agents)).toBe('')
    expect(lineTextFor(withShownWords(A, 'see #No'), 'me', null, [], [{ name: 'Notes', kind: 'note' } as never])).toBe(`see  ${A}`)
  })
})
