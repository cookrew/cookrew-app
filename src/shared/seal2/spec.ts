/**
 * COOKREW-SEAL/2: ONE END-TO-END SESSION EVERY REMOTE PATH RIDES.
 *
 * Phone or console to its Mac, desktop to desktop on one account, and Magpie's
 * model traffic all travel as streams inside this session. Whatever carries it
 * (the registry relay today, a WebSocket later, a LAN socket) sees ciphertext,
 * sizes, timing and a record's sequence number. Never a token, path, header,
 * body or key.
 *
 * This file is the specification; the modules beside it implement it with
 * WebCrypto alone, so the Mac, the page and the console run one copy.
 * scripts/seal-v2-vectors.mjs is a second implementation in node:crypto that
 * writes tests/fixtures/seal-v2-vectors.json; the Swift client
 * (watch/Sources/CookrewCore/Seal2.swift) checks itself against the same file.
 *
 * Notation: `|` concatenation, u8/u16/u32/u64 big-endian, HKDF = RFC 5869
 * HKDF-SHA-256 (extract and expand), b64u = unpadded base64url, H = SHA-256.
 *
 * ── 1. VERSIONS ─────────────────────────────────────────────────────────────
 *
 * A client offers the versions it speaks; the responder picks the highest it
 * shares. The offer and the choice are in the transcript, so a carrier cannot
 * rewrite them without breaking the proofs.
 *
 * Code mode keeps v1's shape, `{ v: 1, vs: [2], id, e }`: a Mac from before v2
 * ignores `vs` and answers v1 (canvas-seal.ts), which is still sealed. A v2 Mac
 * answers `{ v: 2, ... }`. A carrier that strips `vs` can force v1, so a client
 * that has once seen v2 from a code PINS it and refuses v1 for that code
 * afterwards (path/seal-pin.ts). Device mode has no v1 and never falls back.
 * No mode ever falls back to plaintext.
 *
 * ── 2. HANDSHAKE ────────────────────────────────────────────────────────────
 *
 *   e_i, e_r     fresh X25519 keys, initiator and responder
 *   CODE MODE    the connect code (32 bytes, carried in a QR fragment, never
 *                sent) authenticates both ends.
 *     id         HKDF(code, "", "cookrew-canvas-seal/1 id", 16): v1's, so one lookup serves both
 *     hello      { v: 1, vs, id: b64u(id), e: b64u(e_i) }
 *     context    id
 *     ikm        X25519(e_i, e_r) | code
 *   DEVICE MODE  each desktop's Ed25519 account device key authenticates it.
 *                A device id is a one-way function of its key (account-v2.ts ·
 *                deviceIdFor), so the id a desktop dials pins the key it
 *                accepts. See device-trust in seal2/handshake.ts for what is
 *                trusted.
 *     hello      { v: 2, vs, mode: "device", from, to, jwk: {kty,crv,x}, e }
 *     context    uuid(from) | uuid(to) | thumb(jwk_i) | thumb(jwk_r)
 *     ikm        X25519(e_i, e_r)
 *
 *   transcript   th = H("cookrew-seal/2" | u8 0 | u8 mode | u8 chosen | u8 n | vs[n] | context | e_i | e_r)
 *                mode: 1 code, 2 device
 *   keys         HKDF(ikm, salt th, "cookrew-seal/2 keys", 96)
 *                = secret to-responder | secret to-initiator | confirm key
 *   proof(who)   HMAC-SHA-256(confirm, who | th), who = "responder" | "initiator"
 *   sig(who)     DEVICE MODE: Ed25519 over utf8("cookrew-seal/2 <who>\n" + b64u(th))
 *   accept       { v: 2, e: b64u(e_r), proof } and in device mode also { jwk, sig }
 *   finish       { proof } and in device mode also { sig }
 *   session id   b64u(th[0:16])
 *
 *   Nothing is sent inside a session until the responder's proof (and in
 *   device mode its signature) checked; the responder keeps nothing until the
 *   initiator's did.
 *
 * ── 3. RECORDS ──────────────────────────────────────────────────────────────
 *
 *   One secret per direction, s. Epoch n covers sequence numbers
 *   [n * 2^16, (n+1) * 2^16): REKEYING is automatic and needs no message.
 *     s_0 = s,  s_(n+1) = HKDF(s_n, "", "cookrew-seal/2 next", 32)
 *     key_n = HKDF(s_n, "", "cookrew-seal/2 key", 32)
 *     iv_n  = HKDF(s_n, "", "cookrew-seal/2 iv", 12)
 *   An end forgets s_n once no record of epoch n can still arrive, so a key
 *   taken later does not open earlier epochs.
 *     nonce = iv_n XOR (u32 0 | u64 seq)
 *     aad   = "cookrew-seal/2" | u8 dir | u64 seq     dir 1 to-responder, 2 to-initiator
 *     box   = AES-256-GCM(key_n, nonce, aad, frame)  (ciphertext | 16-byte tag)
 *     wire  = u32 (8 + |box|) | u64 seq | box          (v1's layout)
 *   seq starts at 0, goes up by one per record, and stops at 2^48.
 *   REPLAY, REORDER, REFLECTION: the receiver delivers records in sequence, each
 *   once (canvas-seal-wire.ts · createInbox, 1024 ahead at most); a record moved
 *   to another number, direction or session does not open.
 *   TRUNCATION: a stream is complete only on its own END frame, a session only
 *   on GOAWAY; ending without them is an error, never a clean end.
 *
 * ── 4. FRAMES (one per record) ──────────────────────────────────────────────
 *
 *   u8 type | u32 stream | body
 *   1 OPEN    u8 n | kind[n] (ascii [a-z][a-z0-9-]*) | fields
 *   2 HEAD    u16 status | fields
 *   3 DATA    bytes, at most DATA_MAX
 *   4 END     (empty) the sender's direction of the stream is finished
 *   5 ABORT   u16 code | utf8 reason: the whole stream is over, both ways
 *   6 ACK     stream 0, u64 next: every record below `next` arrived
 *   7 PING    stream 0, (empty)
 *   8 CREDIT  u32 bytes: the sender may send that many more DATA bytes
 *   9 GOAWAY  stream 0, u16 code | utf8 reason: no new streams; close when done
 *   fields  = u16 count | (u16 n | name[n] | u32 m | value[m])*, UTF-8, no repeats
 *
 *   STREAMS: the initiator opens odd ids, the responder even, each rising. A
 *   reused or lower id ends the session. Each end keeps at most MAX_STREAMS of
 *   its own open; more wait their turn at the sender, and an OPEN past the
 *   limit is refused with BUSY. The acceptor answers HEAD before
 *   DATA; for kind "http" HEAD's status is the HTTP status, for other kinds 200
 *   means accepted. Either side ends its own direction with END, or the whole
 *   stream with ABORT.
 *   FLOW: every stream starts with STREAM_WINDOW bytes of credit each way. A
 *   sender never sends DATA past its credit; a receiver grants CREDIT as its
 *   reader takes bytes, so a slow reader holds back only its own stream. DATA
 *   past the credit aborts the stream (code FLOW). The session as a whole is
 *   held back by unacknowledged bytes (HIGH_WATER) and ended past HARD_LIMIT.
 *   LIVENESS: each end sends PING every PING_MS; ACK, PING and every other
 *   frame are what say the far end is alive.
 *   ACKS: every frame but ACK asks for one. Acks are what let a sender forget
 *   a record it keeps for resending; a resend is the same bytes, never a new
 *   seal.
 *
 * ── 5. KIND "http" ──────────────────────────────────────────────────────────
 *
 *   OPEN fields: ":method", ":path" (a path on the far server, never a URL),
 *   then request headers, lower-case. HEAD: status and response headers.
 *   Bodies are DATA both ways, END-ed. Server-sent events are an ordinary
 *   response body that has not ended yet.
 */

export const SEAL2_LABEL = 'cookrew-seal/2'
export const SEAL2_VERSION = 2
/** Every version this build speaks, highest first. 1 is canvas-seal.ts. */
export const SEAL_VERSIONS = [2, 1] as const

export const MODE_CODE = 1
export const MODE_DEVICE = 2

export const EPOCH_RECORDS = 2 ** 16
export const SEQ_LIMIT = 2 ** 48
export const RECORD_MAX = 256 * 1024
export const FRAME_HEAD_BYTES = 5
export const DATA_MAX = RECORD_MAX - FRAME_HEAD_BYTES

/** Credit each direction of a new stream starts with. */
export const STREAM_WINDOW = 1024 * 1024
/** Credit is granted back in steps at least this large, or when a reader has taken half the window. */
export const CREDIT_STEP = 64 * 1024
export const MAX_STREAMS = 64
/** Past this many unacknowledged bytes, writers wait. */
export const HIGH_WATER = 8 * 1024 * 1024
/** Past this, the session ends: something ignored the wait. */
export const HARD_LIMIT = 32 * 1024 * 1024
export const PING_MS = 20_000
export const SILENT_MS = 90_000
/** How long an ack may wait to ride with others. */
export const ACK_DELAY_MS = 20

export const FIELDS_MAX_BYTES = 64 * 1024
export const FIELDS_MAX_COUNT = 128
export const REASON_MAX_BYTES = 256

/** ABORT and GOAWAY codes. */
export const ABORT = {
  none: 0,
  cancel: 1,
  refused: 2,
  flow: 3,
  tooLarge: 4,
  timeout: 5,
  internal: 6,
  busy: 7,
  protocol: 8,
  unknownKind: 9,
  upstream: 10,
  ended: 11
} as const
export type AbortCode = (typeof ABORT)[keyof typeof ABORT]
