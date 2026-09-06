import type http from 'node:http'
import { RELAY_MARKER, isLoopbackPeer } from './relay-base'

/**
 * WHO THE REGISTRY SAYS IS ASKING — and why that is not the same as WHO MAY.
 *
 * Down the relay every request reaches this Mac from 127.0.0.1, through the
 * bridge, carrying no identity of its own: the phone's account session lives
 * at cookrew.dev and stops there. So the registry, which does know who signed
 * in, names the caller in two headers, and the Mac uses them for exactly one
 * thing — what the admitted-devices row is CALLED.
 *
 * THEY AUTHORISE NOTHING. The pairing token is the one credential, on the LAN
 * and on the relay alike; a request without it is refused whether or not it
 * says who it is, and a request with it is served whether or not it does. That
 * separation is the point: a header that could open a Mac would be a second
 * credential, and reach v2.1 exists to have exactly one.
 *
 * TRUSTED UNDER THE SAME TWO CONDITIONS AS x-cookrew-base, and for the same
 * reasons (relay-base.ts):
 *
 *   IT ARRIVED THROUGH THE BRIDGE. `x-cookrew-relay: 1` is written by
 *   canvas-bridge over whatever the caller sent.
 *
 *   IT ARRIVED ON LOOPBACK. The marker is a header and headers can be typed,
 *   so the peer is checked too. A LAN client forging both is refused on the
 *   address; a local process that could forge both can already reach
 *   everything this server has.
 *
 * AND THE VALUES ARE STILL CHECKED. The id must be a device id and the name is
 * cut to printable ASCII, because both are written to a file and drawn in a
 * sheet, and "the registry set it" is not a reason to store a terminal escape.
 */

/** Set by the registry from the caller's session. Read here and nowhere else. */
export const RELAY_DEVICE_HEADER = 'x-cookrew-device'
export const RELAY_DEVICE_NAME_HEADER = 'x-cookrew-device-name'

/** Long enough for "Andrej's iPhone 15 Pro", short enough to draw in a row. */
export const DEVICE_NAME_MAX = 64

/** The device id account-v2 derives from a device key: a lowercase UUID. */
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One header value, or nothing — an array means the caller sent it twice. */
const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null

/**
 * A name safe to store and to draw.
 *
 * Kept as an EDIT rather than a refusal: a phone called "iPhone 📱" should be
 * listed as "iPhone", not as nothing. Everything outside printable ASCII goes,
 * runs of whitespace collapse, and what is left is cut to 64.
 */
export const safeDeviceName = (raw: unknown): string | undefined => {
  const value = single(raw as string | string[] | undefined)
  if (value === null) return undefined
  const cleaned = value
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
  return cleaned.length > 0 ? cleaned : undefined
}

export type RelayDevice = {
  readonly deviceId: string
  readonly name?: string
}

export interface RelayDeviceInput {
  readonly marker: string | string[] | undefined
  readonly deviceId: string | string[] | undefined
  readonly deviceName: string | string[] | undefined
  readonly remoteAddress: string | undefined
}

/** The device this request may be said to come from, or null. */
export const relayDeviceOf = (input: RelayDeviceInput): RelayDevice | null => {
  if (input.marker !== '1') return null
  if (!isLoopbackPeer(input.remoteAddress)) return null
  const deviceId = single(input.deviceId)
  if (!deviceId || !DEVICE_ID.test(deviceId)) return null
  const name = safeDeviceName(input.deviceName)
  return name === undefined ? { deviceId } : { deviceId, name }
}

/**
 * Read the device off a request, and take the headers OFF it.
 *
 * The strip is unconditional and it is the reason this is one function rather
 * than a reader anyone may call: a forged `x-cookrew-device` from the LAN is
 * refused here, and after this nothing downstream — a route, a log line, a
 * future reader who did not read this file — can even see it to believe it.
 *
 * This mutates `request.headers`, which is the one place in this codebase
 * where that is the correct thing to do: the request is not a value we own, it
 * is the wire, and neutralising a header at the door is exactly the point.
 */
export const takeRelayDevice = (request: http.IncomingMessage): RelayDevice | null => {
  const device = relayDeviceOf({
    marker: request.headers[RELAY_MARKER],
    deviceId: request.headers[RELAY_DEVICE_HEADER],
    deviceName: request.headers[RELAY_DEVICE_NAME_HEADER],
    remoteAddress: request.socket?.remoteAddress
  })
  delete request.headers[RELAY_DEVICE_HEADER]
  delete request.headers[RELAY_DEVICE_NAME_HEADER]
  return device
}
