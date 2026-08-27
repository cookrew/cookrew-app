import { describe, expect, it } from 'vitest'
import {
  PHONE_BOARD_PAGE_SIZE,
  appendBoardEvent,
  boardEventLimit,
  nextPhoneBoardLimit,
  phoneBoardWindow,
} from '../src/renderer/src/phone-board-window'

const rows = Array.from({ length: 91 }, (_, index) => `row-${index}`)

describe('phone Board render window', () => {
  it('mounts one bounded page and keeps the rest available', () => {
    const window = phoneBoardWindow(rows, PHONE_BOARD_PAGE_SIZE, true)

    expect(window.visible).toEqual(rows.slice(0, 12))
    expect(window.remaining).toBe(79)
  })

  it('advances in bounded pages and caps at the available rows', () => {
    expect(nextPhoneBoardLimit(rows.length, 12)).toBe(24)
    expect(nextPhoneBoardLimit(rows.length, 84)).toBe(91)
    expect(nextPhoneBoardLimit(5, 12)).toBe(5)
  })

  it('keeps desktop eager rendering unchanged', () => {
    expect(phoneBoardWindow(rows, PHONE_BOARD_PAGE_SIZE, false)).toEqual({
      visible: rows,
      remaining: 0,
    })
  })

  it('normalizes invalid limits without creating negative remaining counts', () => {
    expect(phoneBoardWindow(rows, -4, true)).toEqual({ visible: [], remaining: 91 })
    expect(phoneBoardWindow(rows, 12.9, true).visible).toHaveLength(12)
    expect(nextPhoneBoardLimit(-1, 12)).toBe(0)
  })

  it('keeps phone history small without changing desktop depth', () => {
    expect(boardEventLimit(true)).toBe(256)
    expect(boardEventLimit(false)).toBe(4000)
  })

  it('retains only the newest live events at the configured limit', () => {
    expect(appendBoardEvent(['a', 'b'], 'c', 3)).toEqual(['a', 'b', 'c'])
    expect(appendBoardEvent(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
    expect(appendBoardEvent(['a'], 'b', 0)).toEqual(['b'])
  })
})
