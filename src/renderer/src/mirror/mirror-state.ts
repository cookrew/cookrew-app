import type { MirrorPage } from '../../../shared/dom-mirror'
import type { MirrorMessage } from './mirror-message'

/**
 * WHAT THE MIRROR VIEW IS SHOWING (mirror/mirror-state.ts), as a pure step
 * function so every transition can be read and tested without a line.
 *
 * There is no state here that means "show the screen instead": a page the
 * mirror cannot read is `failed`, with the reason in words, and the viewer
 * decides whether to press Screen (owner ruling 2026-11-23: no automatic
 * pixel fallback).
 */
export type MirrorState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reading' }
  | { readonly phase: 'ready'; readonly page: MirrorPage; readonly busy: boolean; readonly note: string | null }
  | { readonly phase: 'failed'; readonly why: string }

export type MirrorEvent =
  | { readonly type: 'close' }
  | { readonly type: 'open' }
  /** A read or an act went out; the page on screen stays while it is answered. */
  | { readonly type: 'asked' }
  | { readonly type: 'message'; readonly message: MirrorMessage }
  | { readonly type: 'lost'; readonly why: string }

export const MIRROR_IDLE: MirrorState = { phase: 'idle' }

export function nextMirror(state: MirrorState, event: MirrorEvent): MirrorState {
  switch (event.type) {
    case 'close':
      return MIRROR_IDLE
    case 'open':
      return { phase: 'reading' }
    case 'asked':
      return state.phase === 'ready' ? { ...state, busy: true, note: null } : state.phase === 'failed' ? { phase: 'reading' } : state
    case 'lost':
      return { phase: 'failed', why: event.why }
    case 'message': {
      const message = event.message
      if (message.kind === 'dom') return { phase: 'ready', page: message.page, busy: false, note: null }
      // An act the page refused leaves the page as it was, with the reason above it.
      if (message.stage === 'act' && state.phase === 'ready') return { ...state, busy: false, note: message.why }
      return { phase: 'failed', why: message.why }
    }
  }
}
