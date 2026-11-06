import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'

/**
 * WHICH WINDOW A CARD HOLDS, ACROSS A RESTART.
 *
 * An address carries a window id, and an id dies with its app. So a card remembers
 * what the window was while it could see it, written by this process and never read
 * from a card's name, which callers can set. `from` is the id in the address it was
 * learned under: a card pointed elsewhere since remembers nothing. Titles can name
 * people, so the file is the owner's alone and denied to served seats.
 */

export interface WindowMemo {
  /** The id in the card's address. */
  readonly from: number
  /** The id the window has now. */
  readonly id: number
  readonly title: string
  /** The process that owned it: the same one means the app never went away. */
  readonly pid: number | null
  /** No other window of the app had this title, so the title can name it. */
  readonly alone: boolean
}

export interface WindowMemory {
  read(): WindowMemo | null
  write(memo: WindowMemo): void
}

const isMemo = (raw: unknown): raw is WindowMemo => {
  const memo = raw as Partial<WindowMemo> | null
  return typeof memo?.from === 'number' && typeof memo.id === 'number' && typeof memo.title === 'string' && (memo.pid === null || typeof memo.pid === 'number') && typeof memo.alone === 'boolean'
}

function readAll(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const writeAll = (file: string, all: Record<string, unknown>): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify(all))
}

/** The card is gone: its window's title has no reason to stay on disk. */
export function forgetCardWindow(file: string, card: string): void {
  const { [card]: gone, ...rest } = readAll(file)
  if (gone === undefined) return
  try {
    writeAll(file, rest)
  } catch (error) {
    console.error('Failed to forget a card window:', error)
  }
}

export function fileWindowMemory(file: string, card: string): WindowMemory {
  return {
    read() {
      const held = readAll(file)[card]
      return isMemo(held) ? held : null
    },
    write(memo) {
      try {
        writeAll(file, { ...readAll(file), [card]: memo })
      } catch (error) {
        // Only a window that closes before the next write is lost by this.
        console.error('Failed to remember a card window:', error)
      }
    }
  }
}
