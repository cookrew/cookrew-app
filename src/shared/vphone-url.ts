/**
 * A VIRTUAL iPHONE IS A BROWSER CARD WHOSE ADDRESS NAMES A MACHINE.
 *
 * `vphone://<machine>` backs the card with a vphone-cli guest instead of a
 * headless Chrome (main/vphone-instance.ts); `vphone://<machine>/<bundle id>`
 * also names the app to bring to the front. The scheme is read in two
 * places and nowhere else: the manager, to pick the instance kind, and the
 * renderer, to keep the address out of any <webview> or <iframe>.
 *
 * Machine names are directory names under the vphone library, so they are
 * held to the characters a directory name can safely carry and may not
 * start with a dot: `vphone://../x` is not a machine.
 */

export const VPHONE_SCHEME = 'vphone:'

const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/

export interface VphoneTarget {
  readonly machine: string
  /** The bundle id to launch, or null for "whatever is on screen". */
  readonly app: string | null
}

export const isVphoneUrl = (url: string): boolean => parseVphoneUrl(url) !== null

export const parseVphoneUrl = (url: string): VphoneTarget | null => {
  const match = /^vphone:\/\/([^/?#]*)(?:\/([^/?#]*))?\/?$/i.exec(url.trim())
  if (!match) return null
  const [, machine, app = ''] = match
  if (!MACHINE.test(machine)) return null
  if (app.length > 0 && !BUNDLE.test(app)) return null
  return { machine, app: app.length > 0 ? app : null }
}

export const vphoneUrl = (machine: string, app?: string | null): string =>
  app ? `vphone://${machine}/${app}` : `vphone://${machine}`
