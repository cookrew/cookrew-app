/**
 * WEBAUTHN, ON THE WIRE AND IN THE BROWSER — the two shapes of the same
 * ceremony, and nothing else.
 *
 * The registry speaks JSON, so a challenge and a user id are base64url
 * STRINGS; `navigator.credentials` speaks ArrayBuffers. That translation is
 * the whole of this file, and it is a file of its own so it can be tested
 * without a platform authenticator — this machine may not have one, and a
 * conversion bug that only shows up on hardware is a bug nobody sees until an
 * owner cannot enrol.
 *
 * NOTHING IS INVENTED HERE. The options are passed through field for field
 * apart from the decoding; a renderer that "helpfully" filled in a missing
 * `rp.id` or relaxed `userVerification` would be changing what the account's
 * key is bound to.
 */

/**
 * base64url → bytes. Padding is optional on the wire, so it is restored.
 *
 * The buffer is allocated explicitly rather than through `Uint8Array.from`
 * because WebAuthn wants a `BufferSource` backed by a plain ArrayBuffer, and
 * the inferred type of the convenient form is wide enough to include a shared
 * one — which the DOM will not take.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** bytes → base64url, unpadded: what the registry expects back. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/**
 * The registry's JSON options, as `navigator.credentials.create` wants them.
 *
 * Three fields are bytes and the rest are not; the rest are carried through
 * untouched rather than rebuilt, so a field this app has never heard of still
 * reaches the authenticator.
 */
export function toCreationOptions(raw: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const user = asRecord(raw.user)
  const exclude = Array.isArray(raw.excludeCredentials) ? raw.excludeCredentials : []
  return {
    ...(raw as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64Url(typeof raw.challenge === 'string' ? raw.challenge : ''),
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: fromBase64Url(typeof user.id === 'string' ? user.id : ''),
    },
    ...(exclude.length > 0
      ? {
          excludeCredentials: exclude.map((entry) => {
            const record = asRecord(entry)
            return {
              ...(record as unknown as PublicKeyCredentialDescriptor),
              id: fromBase64Url(typeof record.id === 'string' ? record.id : ''),
            }
          }),
        }
      : {}),
  }
}

/** What the browser made, as the registry reads it back. */
export function fromCredential(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
    },
  }
}

/**
 * Should the row offer the browser instead (D3)?
 *
 * Electron reports "there is no platform authenticator here" and "the person
 * pressed escape" as the SAME NotAllowedError, so the two cannot be told
 * apart. The asymmetry decides it: an extra sentence after a deliberate
 * cancel is a line nobody minds, while hiding it after a real refusal leaves
 * an owner pressing a button that will never work and never says why.
 */
export function cannotMakePasskey(error: unknown): boolean {
  if (typeof PublicKeyCredential === 'undefined') return true
  const name = (error as { name?: string } | null)?.name
  return name === 'NotSupportedError' || name === 'NotAllowedError' || name === 'SecurityError'
}

/**
 * Does this build have a PLATFORM authenticator — a Touch ID it can use?
 *
 * Measured on this machine (Electron 33, macOS, 2026-09-06):
 * `navigator.credentials.create` and `PublicKeyCredential` both EXIST, and
 * `isUserVerifyingPlatformAuthenticatorAvailable()` answers FALSE. So the
 * desktop's "Add a passkey (Touch ID)" row cannot deliver Touch ID: pressing
 * it raises the OS's security-key dialog instead, which is a modal about
 * hardware the person was not offered.
 *
 * Asking first is what lets the row say the true thing BEFORE it is pressed
 * (D3's browser sentence) rather than after a dialog the owner had to cancel.
 * A false answer is not a dead end — a security key or a phone over hybrid
 * still works, so the ADD stays — it is a reason to show the way that does.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}
