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
 *   window://Safari?id=48213      that one window, and no other computer
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
 *
 * `id=` is what the window picker writes: the card is bound to that window,
 * so another window of the app, or a new one with the same title, never takes
 * its place. The app name stays beside it as a check on the id, and an app is
 * called whatever it is called, so an id widens the name past the hand-typed
 * set. The title is not in a bound address: it changes, and the card's name
 * already carries it.
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
  /** The one window this card is bound to; absent for an address that finds a window by name. */
  readonly windowId?: number
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
/** A CGWindowID: a uint32, and never 0. */
const WINDOW_ID = /^[1-9][0-9]{0,9}$/
const WINDOW_ID_MAX = 0xffffffff
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

/** The id an address binds to: null for none, undefined for one that is not a window id. */
const parseWindowId = (raw: string | null): number | null | undefined => {
  if (raw === null) return null
  if (!WINDOW_ID.test(raw)) return undefined
  const id = Number(raw)
  return id <= WINDOW_ID_MAX ? id : undefined
}

/** Any app's name, made fit for a bound address; both sides of the check on the id go through this. */
export const windowAppName = (app: string): string =>
  app.replace(/[\u0000-\u001f/\\]+/g, ' ').trim().slice(0, 120).trim() || 'Window'

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
  const query = new URLSearchParams(match[4] ?? '')
  const windowId = parseWindowId(query.get('id'))
  if (windowId === undefined || (windowId !== null && kind !== 'window')) return null
  if (name === null || !(windowId !== null ? DETAIL : NAME).test(name)) return null
  if (detailRaw !== null && (kind !== 'window' || !DETAIL.test(detailRaw))) return null
  const roi = parseRoi(query.get('roi'))
  if (roi === undefined) return null
  if (roi !== null && kind !== 'screen' && kind !== 'window') return null
  return { kind, use: USE_OF[kind], name, detail: detailRaw, roi, ...(windowId !== null ? { windowId } : {}) }
}

export const isUseUrl = (url: string): boolean => parseUseUrl(url) !== null

/** The address for a target — the inverse of parseUseUrl. */
export const useUrl = (target: Pick<UseTarget, 'kind' | 'name' | 'detail' | 'roi' | 'windowId'>): string => {
  const detail = target.detail ? `/${encodeURIComponent(target.detail)}` : ''
  const query = [
    ...(target.windowId ? [`id=${target.windowId}`] : []),
    ...(target.roi ? [`roi=${target.roi.x},${target.roi.y},${target.roi.width},${target.roi.height}`] : [])
  ]
  return `${target.kind}://${encodeURIComponent(target.name)}${detail}${query.length > 0 ? `?${query.join('&')}` : ''}`
}
