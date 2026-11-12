import type { ITheme } from '@xterm/xterm'
import type { ThemeName } from './color-scheme'
import { isDrawnSkin, skinTerminal } from './skins/skin-look'

/* THE LIVE TERMINAL'S COLOURS. xterm draws on a canvas, so no stylesheet
   reaches it: each theme of the app names its palette here. */

/**
 * PAPER, not phosphor (2026-10-30): the live terminal is the app's own cream
 * and ink, like the transcript above it. A light ANSI palette — white and
 * bright white are greys and ink, or they would vanish — and a contrast floor
 * (minimumContrastRatio below) for the truecolor a dark-themed TUI still sends.
 */
export const PAPER_THEME = {
  background: '#FFFEF5',
  foreground: '#2D2A20',
  cursor: '#2D2A20',
  cursorAccent: '#FFFEF5',
  selectionBackground: '#FFF3AD',
  black: '#2D2A20',
  red: '#B91C1C',
  green: '#15803D',
  yellow: '#A16207',
  blue: '#1D4ED8',
  magenta: '#A21CAF',
  cyan: '#0E7490',
  white: '#78716C',
  brightBlack: '#78716C',
  brightRed: '#DC2626',
  brightGreen: '#16A34A',
  brightYellow: '#CA8A04',
  brightBlue: '#2563EB',
  brightMagenta: '#C026D3',
  brightCyan: '#0891B2',
  brightWhite: '#2D2A20'
}

/**
 * The same paper at night (color-scheme.ts, night.css): the companion in a
 * phone's dark mode. Ground and ink are the night tokens; the colours are the
 * light steps of the palette, so they read on the dark ground.
 */
export const NIGHT_THEME = {
  background: '#1D1A14',
  foreground: '#ECE5D3',
  cursor: '#ECE5D3',
  cursorAccent: '#1D1A14',
  selectionBackground: '#3B3212',
  black: '#6F6859',
  red: '#F87171',
  green: '#4ADE80',
  yellow: '#FACC15',
  blue: '#93C5FD',
  magenta: '#F0ABFC',
  cyan: '#67E8F9',
  white: '#A19887',
  brightBlack: '#A19887',
  brightRed: '#FCA5A5',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE047',
  brightBlue: '#BFDBFE',
  brightMagenta: '#F5D0FE',
  brightCyan: '#A5F3FC',
  brightWhite: '#ECE5D3'
}

/**
 * ROOT (owner 2026-11-03): the terminal of the Mr. Robot look. Black ground,
 * pale ink, phosphor green and a red cursor, the same palette as
 * zoom/root-theme.css.
 */
export const ROOT_THEME = {
  background: '#050706',
  foreground: '#DCE1DB',
  cursor: '#FF3B3B',
  cursorAccent: '#050706',
  selectionBackground: '#2A332D',
  black: '#4D564F',
  red: '#FF5C5C',
  green: '#3BE27F',
  yellow: '#D9C45C',
  blue: '#6E9BFF',
  magenta: '#C27CFF',
  cyan: '#39D4D4',
  white: '#A9B2AA',
  brightBlack: '#7D877F',
  brightRed: '#FF8A8A',
  brightGreen: '#7DFFAD',
  brightYellow: '#F2E08A',
  brightBlue: '#9DBBFF',
  brightMagenta: '#DDA8FF',
  brightCyan: '#7FF0F0',
  brightWhite: '#F2F5F1'
}

/** Which palette the terminal wears: a skin's own, the root theme's, else night or paper. */
export const terminalTheme = (theme: ThemeName, night: boolean): ITheme =>
  isDrawnSkin(theme) ? skinTerminal(theme, night) : theme === 'root' ? ROOT_THEME : night ? NIGHT_THEME : PAPER_THEME
