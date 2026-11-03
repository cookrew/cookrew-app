import { parseVphoneUrl } from './vphone-url'

/**
 * EVERY USE IS A BROWSER CARD WHOSE ADDRESS NAMES A SCREEN.
 *
 * An agent does not only browse. It drives a Mac window (computer use), a
 * phone (phone use), or watches a bench through a camera (hardware use). Each
 * of those has a region the owner needs to see — the ROI — and Cookrew
 * already has one surface that streams a region to every viewer and takes a
 * closed vocabulary of input back: the interactive browser card
 * (browser-cast.ts, over the LAN socket and the WebRTC direct link alike). So
 * a use is a card address, and the instance behind it is the only part that
 * knows what the screen is:
 *
 *   screen://main                 the main display              computer
 *   screen://2?roi=0,0,800,600    a display, cropped            computer
 *   window://Safari               the frontmost Safari window   computer
 *   window://Simulator/iPhone 17  a window whose title contains computer
 *   adb://emulator-5554           an Android device over adb    phone
 *   adb://default                 the only attached device      phone
 *   vphone://myphone              a vphone-cli virtual iPhone   phone
 *   cam://0  cam://Payphone       a camera, by index or name    hardware
 *
 * `roi=x,y,w,h` is in POINTS of the display or window, never pixels, so the
 * same address means the same region on a Retina and a non-Retina screen.
 *
 * Names are held to characters a shell and a URL carry safely; nothing here
 * ever reaches a shell unquoted, but the address is also the card's title.
 */

export type UseKind = 'screen' | 'window' | 'adb' | 'vphone' | 'cam'
export type Use = 'browser' | 'computer' | 'phone' | 'hardware'

export interface Roi {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface UseTarget {
  readonly kind: UseKind
  readonly use: Exclude<Use, 'browser'>
  /** Display index or `main`; app name; adb serial or `default`; vphone machine; camera index or name. */
  readonly name: string
  /** The window title fragment, or the vphone bundle id. */
  readonly detail: string | null
  readonly roi: Roi | null
}

const USE_OF: Record<UseKind, UseTarget['use']> = {
  screen: 'computer',
  window: 'computer',
  adb: 'phone',
  vphone: 'phone',
  cam: 'hardware'
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:()-]{0,79}$/
const DETAIL = /^[^\u0000-\u001f/\\]{1,120}$/
/** The largest region anyone has a screen for; a bigger number is a typo. */
const ROI_MAX = 16384

export const parseRoi = (raw: string | null): Roi | null | undefined => {
  if (raw === null || raw === '') return null
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > ROI_MAX)) return undefined
  const [x, y, width, height] = parts
  if (width < 16 || height < 16) return undefined
  return { x, y, width, height }
}

const decode = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** The use a card address names, or null for a web address (and for anything malformed). */
export const parseUseUrl = (url: string): UseTarget | null => {
  const trimmed = url.trim()
  const phone = parseVphoneUrl(trimmed)
  if (phone) {
    return { kind: 'vphone', use: 'phone', name: phone.machine, detail: phone.app, roi: null }
  }
  const match = /^(screen|window|adb|cam):\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(trimmed)
  if (!match) return null
  const kind = match[1].toLowerCase() as Exclude<UseKind, 'vphone'>
  const name = decode(match[2])
  const detailRaw = match[3] === undefined || match[3] === '' ? null : decode(match[3])
  if (name === null || !NAME.test(name)) return null
  if (detailRaw !== null && (kind !== 'window' || !DETAIL.test(detailRaw))) return null
  const roi = parseRoi(new URLSearchParams(match[4] ?? '').get('roi'))
  if (roi === undefined) return null
  if (roi !== null && kind !== 'screen' && kind !== 'window') return null
  return { kind, use: USE_OF[kind], name, detail: detailRaw, roi }
}

export const isUseUrl = (url: string): boolean => parseUseUrl(url) !== null

/** The address for a target — the inverse of parseUseUrl. */
export const useUrl = (target: Pick<UseTarget, 'kind' | 'name' | 'detail' | 'roi'>): string => {
  const detail = target.detail ? `/${encodeURIComponent(target.detail)}` : ''
  const roi = target.roi ? `?roi=${target.roi.x},${target.roi.y},${target.roi.width},${target.roi.height}` : ''
  return `${target.kind}://${encodeURIComponent(target.name)}${detail}${roi}`
}
