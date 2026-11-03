/**
 * ENTER OPENS THE FOLDED BOX (owner, 2026-11-04: "Enter opens it while no
 * input box has focus"). Only a bare Enter on nothing that takes keys of its
 * own: a field, a terminal, a button or a link (Enter presses it), a menu's
 * row, or anything inside an open dialog.
 */

const TAKES_KEYS = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="dialog"]',
  '.xterm'
].join(', ')

export interface EnterKey {
  readonly key: string
  /** Something nearer already took it (a dialog's own Enter). */
  readonly defaultPrevented?: boolean
  readonly isComposing?: boolean
  readonly repeat?: boolean
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}

export function enterOpensBox(e: EnterKey, target: Element | null): boolean {
  if (e.key !== 'Enter' || e.isComposing || e.repeat || e.defaultPrevented) return false
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
  return !target?.closest?.(TAKES_KEYS)
}

/** The fold's own presses: on the zoom's canvas the press that folds the box does nothing else. */
const CANVAS = '.zv-overview'
const MODAL = '[role="dialog"], [aria-modal="true"]'

export function pressOnCanvas(target: Element | null): boolean {
  return !!target?.closest?.(CANVAS) && !target.closest(MODAL)
}

/**
 * What a press outside may NOT fold: the box itself, its menus (some float
 * outside it), its face and the who-picker.
 */
const KEEPS_OPEN = '.cr-prompt, .cr-prompt-menu, .cr-tune-menu, .pf-face, .pf-who, [data-prompt-keep]'

export function keepsBoxOpen(target: Element | null): boolean {
  return !!target?.closest?.(KEEPS_OPEN)
}

/** A field a press goes into to type: the press that folds the box still reaches it. */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm'

export function takesTyping(target: Element | null): boolean {
  return !!target?.closest?.(TYPING)
}
