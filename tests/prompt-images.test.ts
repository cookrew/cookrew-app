// SCREENSHOTS IN A PROMPT, AS PICTURES (owner, 2026-11-01): the prompt box
// and the CHAT/LOG views draw a prompt's screenshots. Which paths in a
// prompt are pictures, and taking one out of the draft again.

import { describe, expect, it } from 'vitest'
import { imageMimeOf, imagePathsIn, withoutImagePath } from '../src/shared/prompt-images'

const SHOT = '/Users/me/.cookrew/attachments/pasted-image-1.png'

describe('imageMimeOf', () => {
  it('knows the picture files by extension, any case', () => {
    expect(imageMimeOf('/a/b.PNG')).toBe('image/png')
    expect(imageMimeOf('/a/b.jpeg')).toBe('image/jpeg')
    expect(imageMimeOf('/a/b.jpg')).toBe('image/jpeg')
    expect(imageMimeOf('/a/b.webp')).toBe('image/webp')
    expect(imageMimeOf('/a/b.gif')).toBe('image/gif')
  })

  it('anything else is not a picture', () => {
    expect(imageMimeOf('/a/b.pdf')).toBeNull()
    expect(imageMimeOf('/a.png/readme')).toBeNull()
    expect(imageMimeOf('/a/png')).toBeNull()
  })
})

describe('imagePathsIn', () => {
  it('finds the absolute image paths among the words', () => {
    expect(imagePathsIn(`look at ${SHOT} please`)).toEqual([SHOT])
    expect(imagePathsIn(`${SHOT}\n${SHOT.replace('1', '2')} both`)).toEqual([SHOT, SHOT.replace('1', '2')])
  })

  it('a path escaped as a terminal drop is (a space in it) is read back whole', () => {
    expect(imagePathsIn('see /Users/me/Desktop/Screen\\ Shot\\ 1.png now')).toEqual(['/Users/me/Desktop/Screen Shot 1.png'])
  })

  it('relative paths, words and other files are not pictures to draw', () => {
    expect(imagePathsIn('shot.png src/a.ts /tmp/notes.txt and [Image #1]')).toEqual([])
  })

  it('a path named twice is drawn once', () => {
    expect(imagePathsIn(`${SHOT} vs ${SHOT}`)).toEqual([SHOT])
  })
})

describe('withoutImagePath', () => {
  it('takes the path out with the space that set it apart', () => {
    expect(withoutImagePath(`look at ${SHOT} please`, SHOT)).toBe('look at please')
    expect(withoutImagePath(`${SHOT} `, SHOT)).toBe('')
    expect(withoutImagePath(`fix this ${SHOT}`, SHOT)).toBe('fix this')
  })

  it('an escaped path goes as the escaped token it is in the text', () => {
    expect(withoutImagePath('a /x/Screen\\ Shot.png b', '/x/Screen Shot.png')).toBe('a b')
  })

  it('other words and other paths stay', () => {
    const other = '/x/other.png'
    expect(withoutImagePath(`${SHOT} ${other} hi`, SHOT)).toBe(`${other} hi`)
  })
})
