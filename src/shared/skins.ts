/**
 * SKINS: the whole app's look, picked once for the account (owner 2026-11-12,
 * after bowel.dev's thirteen). A skin is a palette (light, dark, or both), a
 * face for what is named, a texture on the ground and the live terminal's
 * colours. What the app does stays the same in every skin; only how it is
 * drawn changes, and every agent card, avatar and view follows from the one
 * palette (--sumi-*, zoom/ink-theme.css).
 *
 * The list lives here because three places read it: the registry, which keeps
 * the account's pick; the Mac, which keeps a copy and serves it to its phones;
 * and the renderer, which draws it. Only an id travels.
 *
 * `ink` is the paper Cookrew has always worn (bowel's Paper) and stays the
 * default; `root` is Cookrew's own night-terminal look (zoom/root-theme.css).
 */

export const SKIN_IDS = [
  'ink',
  'broadsheet',
  'phosphor',
  'neon',
  'blueprint',
  'sakura',
  'shanshui',
  'celadon',
  'dunhuang',
  'dusk',
  'aurora',
  'obsidian',
  'riso',
  'root'
] as const

export type SkinId = (typeof SKIN_IDS)[number]

export const DEFAULT_SKIN: SkinId = 'ink'

/** Which schemes a skin draws: both follows the device, light or dark keeps one. */
export type SkinMode = 'both' | 'light' | 'dark'

export interface SkinInfo {
  readonly id: SkinId
  readonly name: string
  readonly zh: string
  readonly note: string
  readonly mode: SkinMode
  /** Its theme colour, for the picker's swatch. */
  readonly accent: string
}

export const SKINS: readonly SkinInfo[] = [
  { id: 'ink', name: 'Paper', zh: '纸墨', note: 'Warm paper and ink, set quietly', mode: 'both', accent: '#E2B866' },
  { id: 'broadsheet', name: 'Broadsheet', zh: '报刊', note: 'Newsprint, serif headlines and vermilion', mode: 'both', accent: '#B3261E' },
  { id: 'phosphor', name: 'Phosphor', zh: '荧光屏', note: 'An old green terminal: monospace and scan lines', mode: 'dark', accent: '#46F08A' },
  { id: 'neon', name: 'Neon', zh: '霓虹', note: 'Glowing magenta and cyan on midnight violet', mode: 'dark', accent: '#FF3FA4' },
  { id: 'blueprint', name: 'Blueprint', zh: '蓝图', note: 'Engineer’s blue, a grid and drafting type', mode: 'dark', accent: '#FFD166' },
  { id: 'sakura', name: 'Sakura', zh: '樱', note: 'Blossom pink, soft type and falling petals', mode: 'both', accent: '#E45A8A' },
  { id: 'shanshui', name: 'Shanshui', zh: '山水', note: 'Rice paper, serif type and a red seal, hills in the mist', mode: 'both', accent: '#C8372D' },
  { id: 'celadon', name: 'Celadon', zh: '青瓷', note: 'Pale green glaze, serif headlines and a fine crackle', mode: 'both', accent: '#3E9C82' },
  { id: 'dunhuang', name: 'Dunhuang', zh: '敦煌', note: 'A mural’s ochre, azurite, malachite and cinnabar', mode: 'both', accent: '#1E8573' },
  { id: 'dusk', name: 'Dusk', zh: '暮色', note: 'An indigo sky sinking to a line of warm light', mode: 'dark', accent: '#FF9E7A' },
  { id: 'aurora', name: 'Aurora', zh: '极光', note: 'Curtains of green and violet over a polar night', mode: 'dark', accent: '#5FF0B0' },
  { id: 'obsidian', name: 'Obsidian', zh: '黑曜', note: 'True black, hairlines and one ember of orange', mode: 'dark', accent: '#FF7A1A' },
  { id: 'riso', name: 'Riso', zh: '孔版', note: 'Risograph: blue ink, fluorescent pink and halftone dots', mode: 'light', accent: '#FF48A0' },
  { id: 'root', name: 'Root', zh: '根', note: 'Black, pale ink and one red, as a terminal draws', mode: 'dark', accent: '#FF3B3B' }
]

export const isSkinId = (value: unknown): value is SkinId =>
  typeof value === 'string' && (SKIN_IDS as readonly string[]).includes(value)

/** Only an exact id is a skin: a stray, old or misspelled value is the default. */
export const skinFrom = (value: unknown): SkinId => (isSkinId(value) ? value : DEFAULT_SKIN)

export const skinInfo = (id: SkinId): SkinInfo => SKINS.find((skin) => skin.id === id) ?? SKINS[0]

/** The phone's route to the Mac's copy: GET it, POST `{ skin }` to pick. */
export const SKIN_PATH = '/api/skin'
