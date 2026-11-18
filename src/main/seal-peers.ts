import type { KeyFingerprint } from '../shared/key-fingerprint'
import type { Fields } from '../shared/seal2/frames'
import { pairWords, startDeviceHandshake, type DeviceSigner, type DeviceVerifier } from '../shared/seal2/handshake'
import { sealedFetch, type SealedRequest, type SealedResponse } from '../shared/seal2/http'
import { runSeal2Link, Seal2RefusedError, shakeHandsOverHttp, type Seal2Link } from '../shared/seal2/http-link'
import type { Seal2Stream } from '../shared/seal2/stream'
import type { SealPinStore } from './seal-pins'

/**
 * openStream(peer, kind): THIS DESKTOP TO ANOTHER OF THE SAME ACCOUNT, SEALED.
 *
 * The interface other lanes build on (cross-device Cookrew, lane Magpie's
 * model traffic). `peer` is the other desktop's account device id; the session
 * is cookrew-seal/2 device mode (shared/seal2/handshake.ts), carried down the
 * relay's machine path under this desktop's account session, so the relay sees
 * ciphertext and which two machines talk, and nothing else.
 *
 * One session per peer, opened on first use and opened again after it ends.
 * A stream is never carried over to a new session: a request in flight when a
 * session dies fails, and the caller decides whether it is safe to send again.
 *
 *   const stream = await peers.openStream(id, 'http', { ':method': 'POST', ':path': '/v1/messages', ... })
 *   const answer = await peers.fetch(id, { method: 'POST', path: '/v1/messages', headers, body })
 *
 * Kinds besides "http" are answered by whoever registered them at the far end
 * (canvas-seal-terminus.ts · SealTerminusDeps.kinds).
 */

export interface SealPeersDeps {
  /** This desktop's account device key. Null with no account: nothing can be dialled. */
  self(): DeviceSigner | null
  readonly verify: DeviceVerifier
  /** One request to another machine of the account down the relay (account-v2.ts · relayed). Throws when there is no way. */
  relayed(deviceId: string, route: string, init: RequestInit): Promise<Response>
  /** With the policy at "pinned", only pairs whose words the owner compared are dialled. */
  readonly pins?: SealPinStore
  /** A session to this desktop opened: first contact is when its words are offered to the owner. */
  onContact?(peer: string): void
  readonly retryMs?: number
  log?(line: string): void
}

export interface SealPeers {
  openStream(peer: string, kind: string, fields?: Fields): Promise<Seal2Stream>
  fetch(peer: string, request: SealedRequest): Promise<SealedResponse>
  /** The words this desktop and that one both show for their pair. */
  words(peer: string): Promise<KeyFingerprint>
  /** Ends every session. */
  close(): void
}

export class SealPeerRefusedError extends Error {}

export function createSealPeers(deps: SealPeersDeps): SealPeers {
  const links = new Map<string, Promise<Seal2Link>>()
  const log = deps.log ?? ((): void => undefined)

  const dial = async (peer: string, onEnded: () => void): Promise<Seal2Link> => {
    const self = deps.self()
    if (self === null) throw new SealPeerRefusedError('This desktop is not signed in to an account.')
    if (deps.pins !== undefined && !deps.pins.allows(peer)) throw new SealPeerRefusedError('Compare the words for this machine on both screens first.')
    const http = {
      url: (path: string) => path,
      fetchFn: ((input, init) => deps.relayed(peer, String(input), init ?? {})) as typeof fetch,
      retryMs: deps.retryMs
    }
    const started = await startDeviceHandshake({ self, to: peer, verify: deps.verify })
    const done = await shakeHandsOverHttp(http, started, async (said) => new Seal2RefusedError('device', `The other machine refused: ${typeof said?.error === 'string' ? said.error : 'no reason'}.`))
    deps.onContact?.(peer)
    return runSeal2Link(http, done.session, {
      onClose: (why) => {
        log(`seal peers: the session to ${peer} ended, ${why}`)
        onEnded()
      },
      log
    })
  }

  const linkTo = (peer: string): Promise<Seal2Link> => {
    const live = links.get(peer)
    if (live !== undefined) return live
    const forget = (): void => {
      if (links.get(peer) === opening) links.delete(peer)
    }
    const opening: Promise<Seal2Link> = dial(peer, forget)
    links.set(peer, opening)
    opening.catch(forget)
    return opening
  }

  const connectionTo = async (peer: string) => {
    const link = await linkTo(peer)
    if (!link.connection.closed) return link.connection
    links.delete(peer)
    return (await linkTo(peer)).connection
  }

  return {
    openStream: async (peer, kind, fields = {}) => (await connectionTo(peer)).openStream(kind, fields),
    fetch: async (peer, request) => sealedFetch(await connectionTo(peer), request),
    words: async (peer) => {
      const self = deps.self()
      if (self === null) throw new SealPeerRefusedError('This desktop is not signed in to an account.')
      return pairWords(self.deviceId, peer)
    },
    close() {
      for (const [peer, link] of links) {
        links.delete(peer)
        void link.then((open) => open.close()).catch(() => undefined)
      }
    }
  }
}
