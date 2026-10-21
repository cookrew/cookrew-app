// THE KEY MAP, pure: a key event plus where focus is → what it means. The
// terminal's own keys never reach here (the embed is its own document), so at
// the terminal level only the shell's chrome and side panels send keys.
import type { StrataLevel } from '../../shared/strata'
import type { Direction } from '../levels/selection'

export type KeyIntent =
  | { type: 'move'; dir: Direction; within: boolean }
  | { type: 'in' }
  | { type: 'out' }
  | { type: 'close' }
  | { type: 'finder' }
  /** Type-to-find: a printable key at levels 0–2 opens the finder with it. */
  | { type: 'find'; text: string }

export interface KeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface KeyContext {
  level: StrataLevel
  /** Focus is in a text field (the finder's input included). */
  typing: boolean
  /** The finder, a summary card held open, or a sheet is up: Esc closes it first. */
  overlayOpen: boolean
}

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

export const keyIntent = (e: KeyLike, ctx: KeyContext): KeyIntent | null => {
  if (ctx.typing) return null
  const mod = e.metaKey || e.ctrlKey
  if ((mod && e.key.toLowerCase() === 'k') || (!mod && !e.altKey && e.key === '/')) return { type: 'finder' }
  if (mod || e.altKey) return null
  if (e.key === 'Escape' || e.key === 'Backspace') {
    if (ctx.overlayOpen) return { type: 'close' }
    return ctx.level === 'machines' ? null : { type: 'out' }
  }
  if (ctx.level === 'terminal') return null
  const dir = ARROWS[e.key]
  if (dir) return { type: 'move', dir, within: !!e.shiftKey && ctx.level !== 'agents' }
  if (e.key === 'Enter' || e.key === ' ') return { type: 'in' }
  if (/^[\p{L}\p{N}]$/u.test(e.key)) return { type: 'find', text: e.key.toLowerCase() }
  return null
}

export const isTypingTarget = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable === true)
