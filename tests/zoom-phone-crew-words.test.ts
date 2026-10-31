// THE CREW'S SMALL WORDS READ ON A PHONE (Gauge, 2026-11-01,
// shots/r3/phone-1-crew.png: "RESTING", "WORKING" and "nothing open" drew at
// ~6px). A phone's crew is drawn at its camera's scale; the words are set
// large enough there to read at 9px or more, on a 375px phone too.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutOf, phoneCamera } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
const phoneBlock = css.slice(css.indexOf('@media (max-width: 759px)'))
const px = Number(phoneBlock.match(/\.zv-scene \.zv-st,\s*\.zv-scene \.zv-cnt \{\s*font-size: ([\d.]+)px/)?.[1])

describe("the crew's words on a phone", () => {
  it('are set larger in the scene on a phone', () => {
    expect(px).toBeGreaterThanOrEqual(11)
  })

  it('read at 9px or more at the crew stop, at 412 and 375 wide, for small and large crews', () => {
    for (const [w, h] of [[412, 760], [375, 680]]) {
      for (const n of [3, 13, 15, 30]) {
        const cam = phoneCamera(layoutOf(modelOf(n), true), 1, null, w, h, 0)
        expect(px * cam.S).toBeGreaterThanOrEqual(9)
      }
    }
  })
})
