import type { AccountSession, DeviceInput } from './account'

/**
 * BINDING THE PHONE AT PAIRING (D2) — no prompt, no second sign-in.
 *
 * Pairing already proves the phone is the owner's: the QR carries the per-run
 * pairing token, and this route sits behind it like every other mutating one.
 * So the phone's own key does not need a ceremony of its own — it needs the
 * desktop to SAY SO, and the desktop already holds the account key that can.
 *
 * The desktop signs `cookrew-bind/1 @handle <deviceId> <thumbprint>` and hands
 * it to the registry with an `account` token. From then on the phone signs for
 * the account itself: it can star a team, open a door's line in its own name,
 * and keep working while the desktop sleeps.
 *
 * WHY THE VALIDATION IS HERE AND NOT IN THE ROUTE. The device id becomes a
 * path segment at the registry (`DELETE .../devices/:id`) and a name in a
 * signed sentence; a body that could carry a slash or a newline into either is
 * the whole attack surface of this route. Keeping it beside the bind means the
 * route is plumbing and this is testable without an HTTP server.
 */

/** A device id: opaque, but it must survive a URL path and a signed line. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/

export interface PairDeviceOutcome {
  status: number
  body: Record<string, unknown>
}

const refuse = (status: number, error: string): PairDeviceOutcome => ({ status, body: { error } })

/**
 * Read a phone's device claim, bind it, and answer.
 *
 * `account` is a FUNCTION because the owner may pick their username after the
 * phone is already paired: reading it once at wiring time would leave the
 * phone permanently told there is no account.
 */
export async function bindPairedDevice(
  body: unknown,
  account: () => AccountSession | null
): Promise<PairDeviceOutcome> {
  const device = readDevice(body)
  if (device === null) {
    return refuse(400, 'that is not a device — expected { id, jwk, kind: "phone", name }')
  }
  const session = account()
  if (session === null) {
    // 409, not 401: the phone's credential is fine and retrying with a better
    // one changes nothing. The thing that is missing is on the DESKTOP, and
    // the sentence has to say where to go.
    return refuse(
      409,
      'this Cookrew has not picked a username yet — open it on the desktop, pick one, then pair again'
    )
  }
  try {
    const bound = await session.bindDevice(device)
    return { status: 200, body: { handle: bound.handle, deviceId: bound.deviceId } }
  } catch (error) {
    console.error('pair: binding the phone failed:', error)
    return refuse(
      502,
      'the registry did not accept this phone — it is paired, but not signed in as you yet'
    )
  }
}

function readDevice(value: unknown): DeviceInput | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as Record<string, unknown>
  // ONLY 'phone'. This route is reached with the pairing token, which is the
  // phone's credential; letting it declare itself a `desktop` or a `passkey`
  // would let a paired phone bind a device the owner's devices list then
  // describes as something it is not.
  if (body.kind !== 'phone') return null
  if (typeof body.id !== 'string' || !DEVICE_ID.test(body.id)) return null
  if (typeof body.jwk !== 'object' || body.jwk === null || Array.isArray(body.jwk)) return null
  const jwk = body.jwk as Record<string, unknown>
  if (typeof jwk.kty !== 'string') return null
  // A PRIVATE HALF IS A REFUSAL, not something to strip. A body carrying `d`
  // means the phone exported a key it was supposed to keep, and quietly
  // accepting the public part would leave that mistake unreported.
  if (jwk.d !== undefined) return null
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
  return {
    id: body.id,
    jwk,
    kind: 'phone',
    name: name.length > 0 ? name : 'a phone'
  }
}
