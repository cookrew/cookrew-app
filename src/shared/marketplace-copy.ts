import type { RotationSheetPayload } from './preset-rotation'

/**
 * MARKETPLACE COPY — Velvet's deck (docs/design/marketplace-copy-deck.html),
 * lifted verbatim into the one module every surface reads.
 *
 * WHY THE STRINGS LIVE HERE AND NOT IN THE PAYLOADS. R14 keeps prose out of the
 * shapes main hands the renderer: a payload carries tokens, counts and verbatim
 * user content, so a sentence baked into one would become an assertion in
 * Magpie's fixtures and freeze the wording. The consequence is that the wording
 * needs a home of its own, and this is it — ONE module, so a copy change is a
 * diff in a single file rather than a hunt through renderers.
 *
 * The values are the deck's bytes, contractions and middle dots included. If a
 * string here disagrees with section 5d, the deck is right and this is a bug;
 * tests/preset-rotation.test.ts pins each one so the drift cannot be quiet.
 */

/** Section 5d — the author key rotation sheet (R20). Eleven strings. */
export const MKT_ROTATION = {
  /** The event, named plainly. Never "security alert". */
  'mkt.rotation.title': '{author} changed signing keys',
  /** The what-survived clause — the first thing read after the title. */
  'mkt.rotation.survived': 'Your installed version keeps working. Nothing changed on your canvas.',
  /** The refusal as a standing state, not a failure. */
  'mkt.rotation.refused': "Cookrew won't install updates signed with the new key until you accept it.",
  'mkt.rotation.evidence.old': 'previously signed by {oldKeyId}',
  'mkt.rotation.evidence.new': 'now signing with {newKeyId}',
  /**
   * "Same account" is the one fact that makes this ordinary rather than
   * alarming — it is the countersignature, said in buyer's English.
   */
  'mkt.rotation.evidence.when': 'rotated {date} · countersigned by the same account',
  /** The link — the buyer can verify without trusting us. */
  'mkt.rotation.evidence.log': 'view in the transparency log',
  /** The one forward action. */
  'mkt.rotation.action': 'TRUST THE NEW KEY',
  /** Names the safe state, which is already true — not "Cancel". */
  'mkt.rotation.dismiss': 'Keep v{current}',
  /** Where the decision lives after the sheet is dismissed (R20's "once"). */
  'mkt.rotation.chip': 'KEY CHANGED',
  /** Toast; the update badge appears normally afterwards. */
  'mkt.rotation.trusted': 'Now trusting {newKeyId} for {presetName}.'
} as const

export type MktRotationId = keyof typeof MKT_ROTATION

/**
 * Section 5 — the denial sheet's FORWARD-COMPATIBILITY contract.
 *
 * `mkt.denied.unknown` is not a fallback nicety. A reason string this client
 * has never seen must render as a sentence, never as the raw token and never as
 * a blank sheet — and it ships in M1, before there are reasons to be unknown,
 * because the version of this client that meets a future reason is the one
 * already installed.
 *
 * The `.noremedy` variant is Velvet's copy-check catching a real bug in the
 * first version: the unknown sheet sent the buyer to the author's page, but
 * `ForbiddenBody.remedy` is OPTIONAL by shape and `scope` is the live case —
 * an old client meeting it would have pointed at an author who cannot fix a
 * disagreement between our client and our registry.
 */
export const MKT_DENIED = {
  'mkt.denied.unknown.title': "Your license doesn't cover this preset",
  'mkt.denied.unknown.body': "{author}'s page has the details.",
  'mkt.denied.unknown.action': "OPEN AUTHOR'S PAGE",
  'mkt.denied.unknown.noremedy.title': "Cookrew couldn't complete that",
  'mkt.denied.unknown.noremedy.body': 'Nothing was installed and nothing was charged.',
  'mkt.denied.unknown.noremedy.action': 'COPY DETAILS'
} as const

export type MktDeniedId = keyof typeof MKT_DENIED

/**
 * Which unknown-denial sheet to render. The presence of a remedy is the whole
 * decision: with one there is somewhere to send the buyer, and without one the
 * only honest thing is to say it stopped, name what survived, and hand over
 * something a bug report can carry.
 */
export function unknownDenialCopy(remedy: string | undefined): {
  title: string
  body: string
  action: string
} {
  return remedy === undefined || remedy.length === 0
    ? {
        title: MKT_DENIED['mkt.denied.unknown.noremedy.title'],
        body: MKT_DENIED['mkt.denied.unknown.noremedy.body'],
        action: MKT_DENIED['mkt.denied.unknown.noremedy.action']
      }
    : {
        title: MKT_DENIED['mkt.denied.unknown.title'],
        body: MKT_DENIED['mkt.denied.unknown.body'],
        action: MKT_DENIED['mkt.denied.unknown.action']
      }
}

/**
 * Fill `{placeholders}`. THROWS on one nobody supplied rather than leaving a
 * brace on screen: an unfilled placeholder is a programming mistake, and the
 * buyer meeting `{author} changed signing keys` on a security sheet is worse
 * than a crash a test catches.
 */
export function fillCopy(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`marketplace copy: no value for {${name}}`)
    return String(value)
  })
}

/**
 * How a key id is shown to a person. Full ed25519 key ids are 43 base64url
 * characters — unreadable, and worse, unCOMPARABLE: a buyer asked to tell two
 * 43-character strings apart will not. Eight characters of key material is
 * enough to match against the transparency log by eye, and the ellipsis says
 * plainly that this is not the whole thing.
 */
const SHORT_KEY_CHARS = 8

export function shortKeyId(keyId: string): string {
  const colon = keyId.indexOf(':')
  if (colon === -1) return keyId
  const prefix = keyId.slice(0, colon + 1)
  const material = keyId.slice(colon + 1)
  if (material.length <= SHORT_KEY_CHARS) return keyId
  return `${prefix}${material.slice(0, SHORT_KEY_CHARS)}…`
}

/**
 * R8, THE VERSION LABEL RULE (deck section 7): v1–v9 render LABELLED, 10 and
 * above render as a bare number. The rail draws 100+ as a flag with the exact
 * version in its fan row, which is an affordance rather than a spelling — so
 * copy renders the exact number either way.
 *
 * "No string may truncate or round a version", because a wrong version is worse
 * than an absent one. Every marketplace surface reads this one function, or the
 * dock and a shared link end up disagreeing about what the same preset is
 * called.
 */
export function versionLabel(version: number): string {
  return version <= 9 ? `v${version}` : String(version)
}

/**
 * OPEN QUESTION FOR VELVET, deliberately not resolved here. Section 7's R8 rule
 * says 10+ renders bare, but `mkt.rotation.dismiss` and `mkt.update.dismiss`
 * spell their version as a literal `v{current}` — so a buyer on v12 is offered
 * either "Keep v12" (the template verbatim) or "Keep 12" (R8 applied). The
 * templates are lifted verbatim above and therefore say "Keep v12" today.
 *
 * Left alone on purpose: quietly reinterpreting an owned string to satisfy a
 * rule from another section is how copy drifts away from the person who wrote
 * it. Flagged on the product note; whichever she picks is a one-line change.
 */

/**
 * An author, as the deck writes identity: `@handle`. Idempotent, because a
 * publisher who typed the @ themselves must not become `@@them`.
 */
export function authorLabel(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`
}

/**
 * The rotation sheet's strings, rendered from the payload.
 *
 * The DATE arrives already formatted. Absolute dates are the deck's rule (§7)
 * but their spelling is a locale decision, and a formatter frozen in a shared
 * module would be the wrong one for somebody. The caller formats `payload.at`
 * and passes the result.
 */
export function rotationSheetCopy(
  payload: RotationSheetPayload,
  options: { date: string }
): Record<MktRotationId, string> {
  const vars = {
    author: payload.authorHandle,
    presetName: payload.presetName,
    current: payload.currentVersion,
    oldKeyId: shortKeyId(payload.oldKeyId),
    newKeyId: shortKeyId(payload.newKeyId),
    date: options.date
  }
  const out = {} as Record<MktRotationId, string>
  for (const [id, template] of Object.entries(MKT_ROTATION) as [MktRotationId, string][]) {
    out[id] = fillCopy(template, vars)
  }
  return out
}

/**
 * ── THE PROTOCOL MOMENTS ─────────────────────────────────────────────────────
 *
 * Magpie's give-up reason 5: every human decision point in this product is raw
 * JSON. `{}` at 401, a bare epoch integer at 402, the word `scope` at 403, and
 * base64 assembled by hand to pay. The protocol was finished and the sentences
 * were not, so a person meeting the gate met a debugger instead of a product.
 *
 * These are those sentences. Same rules as everything above: one fact then one
 * move, no status codes and no reason tokens (R14), no reassurance that is not
 * true by construction, and the "what survived" half of every failure derived
 * from real state rather than written as comfort.
 */

/**
 * 401 — identity, R31 vocabulary: THIS IS AN ACCOUNT.
 *
 * The previous strings said there was no account, which was true until R31
 * created one. "Sign in with your Cookrew account" is the most familiar
 * sentence on the internet and it now describes the product accurately — the
 * passkey is HOW the account signs in, a mechanism, not a concept the user has
 * to meet. It appears in the sub-line where a person looks for reassurance
 * about typing a password, and nowhere else.
 *
 * The one thing still banned here is "password", because there still is not
 * one; and "unlock", because it hides whether money moves.
 */
export const MKT_AUTH = {
  'mkt.auth.title': 'Sign in with your Cookrew account',
  'mkt.auth.body':
    'This preset asks who you are before it downloads. Signing in takes one tap — your account uses a passkey, so there is no password to remember.',
  'mkt.auth.why': 'Authors can see how many people installed a preset, never who you are.',
  'mkt.auth.method': 'Use the passkey on this device',
  'mkt.auth.method.alt': 'or scan with your phone',
  'mkt.auth.custody': 'Cookrew stores no password and never sees your key.',
  'mkt.auth.notwallet':
    "Your account isn't a wallet — paying comes later, and only if a preset costs.",
  'mkt.auth.action': 'SIGN IN',
  'mkt.auth.newaccount': 'No account yet? Signing in makes one — it takes the same tap.',
  'mkt.auth.dismiss': 'Not now',
  /** The 90-second challenge died while the sheet sat open. Not a cancel. */
  'mkt.auth.expired': 'That request timed out. Try again.',
  'mkt.auth.cancelled': 'Passkey cancelled.',
  'mkt.auth.unsupported.title': "This browser can't sign you in",
  'mkt.auth.unsupported.body':
    "It can't make a passkey, which is how Cookrew accounts sign in. Use your phone instead.",
  'mkt.auth.unsupported.action': 'SCAN WITH PHONE'
} as const

/**
 * 402 — the money. Every line here is a fact the buyer is entitled to before
 * they approve a transfer, and three of them have never existed in the product:
 * where the money lands, what the registry takes, and what a second download
 * costs.
 */
export const MKT_PAY = {
  'mkt.pay.title': '{presetName} · {price} {asset}',
  'mkt.pay.chain': 'on {chain}',
  /** THE sentence. Cookrew is not a middleman and has never held a cent. */
  'mkt.pay.destination': 'Paid directly to {author} — Cookrew never holds your money and takes nothing.',
  /** Chosen by pricing.model. What you are buying, in the buyer's words. */
  'mkt.pay.model.onetime': 'One-time — yours to place as often as you like.',
  'mkt.pay.model.percall': 'Per call — you top up a balance and each call draws from it.',
  /**
   * THE RECEIPT LINE. Magpie: the most convincing thing in the money story and
   * completely invisible. Entitlement is minted once and every later download
   * is a plain 200, so a buyer who reinstalls, switches machines or updates
   * never pays again — and nobody has ever told them.
   */
  'mkt.pay.receipt': 'Pay once. Re-downloading it later — new machine, reinstall, update — is free.',
  'mkt.pay.expires': 'This price is held for {mmss}.',
  'mkt.pay.choose': 'Choose a wallet',
  'mkt.pay.choose.qr': 'WalletConnect — scan QR',
  'mkt.pay.choose.none': 'No wallet on this device — scan the QR with one on your phone.',
  'mkt.pay.custody':
    'You approve the transfer in your wallet. Cookrew never holds your keys and cannot move funds on its own.',
  'mkt.pay.action.connect': 'CONNECT WALLET',
  'mkt.pay.action.pay': 'PAY {price} {asset}',
  'mkt.pay.dismiss': 'Cancel',
  'mkt.pay.error.rejected': 'You declined the transfer in your wallet. Nothing was charged.',
  'mkt.pay.error.chain': 'Your wallet is on {current}. This costs {price} {asset} on {chain}.',
  'mkt.pay.error.chain.action': 'SWITCH TO {chain}',
  'mkt.pay.error.funds': 'You have {balance} {asset}. This costs {price} {asset}.',
  'mkt.pay.error.expired.body': 'These terms expired. Prices are quoted for five minutes.',
  'mkt.pay.error.expired.action': 'GET NEW TERMS',
  'mkt.pay.pending.title': 'Payment sent — waiting for confirmation',
  'mkt.pay.pending.body': "This usually takes seconds. You can close this; it unlocks itself.",
  /** Prepaid credit rides the buy sheet (R5) so it is never asked for mid-call. */
  'mkt.pay.credit.head': 'Prepaid calls',
  'mkt.pay.credit.add': 'Add {amount} {asset} for remote calls',
  'mkt.pay.credit.estimate': '≈ {n} calls at today’s rate',
  'mkt.pay.credit.skip': 'Top up any time from the chip.'
} as const

/**
 * The install page's price line (Forge owns that surface; this is its copy).
 * A stranger reading a link needs the number, the cadence and the destination
 * in one line, before they have any app to explain it to them.
 */
export const MKT_INSTALL_PRICE = {
  'mkt.install.price.free': 'Free.',
  'mkt.install.price.onetime': '{price} {asset}, once — paid directly to {author}.',
  'mkt.install.price.percall': '{price} {asset} per call — paid directly to {author}.',
  'mkt.install.price.note': 'Cookrew never holds the money and takes nothing.',
  /**
   * R31: an account IS the thing now, so the plainest sentence is also the true
   * one. The earlier version danced around the word because there was nothing
   * to point at.
   */
  'mkt.install.gated.note':
    'Sign in with your Cookrew account to download this — one tap, no password.'
} as const

/** 403 — six reasons, six next actions. One word for all of them was the bug. */
export const MKT_DENIED_REASONS = {
  'mkt.denied.seat_limit.title': 'No seat available',
  'mkt.denied.seat_limit.body':
    'All {n} seats on this licence are in use: {deviceList}. Manage them on {author}’s page.',
  'mkt.denied.seat_limit.action': 'ASK {author} ↗',

  'mkt.denied.version_gate.title': 'Your licence covers {from}–{to}',
  'mkt.denied.version_gate.body': 'This preset is {wanted}.',
  'mkt.denied.version_gate.action': 'UPGRADE TO {wanted}',

  'mkt.denied.refunded.title': 'This purchase was refunded',
  'mkt.denied.refunded.body': 'The licence ended on {date}.',
  'mkt.denied.refunded.action': 'BUY AGAIN',

  'mkt.denied.revoked.title': '{author} revoked this licence',
  'mkt.denied.revoked.body': '{authorNote}',
  'mkt.denied.revoked.action': 'CONTACT {author}',

  'mkt.denied.region.title': 'Not available in your region',
  'mkt.denied.region.body': "{author} hasn't published this preset where you are.",
  'mkt.denied.region.action': 'LEARN WHY',

  /** R11/R12/R15 — the only 403 the buyer can clear, and the only one that may
   *  promise continuity. Past tense is true by R12, future by R13. */
  'mkt.denied.balance_empty.title': 'Out of credit',
  'mkt.denied.balance_empty.body':
    '{presetName} has {amount} {asset} left. Its last answer completed — nothing was lost. Topping up resumes the same conversation.',
  'mkt.denied.balance_empty.action': 'TOP UP',

  /** R26 — retried silently once, then explained. Our defect, not their choice. */
  'mkt.denied.scope.title': "Cookrew couldn't get permission for that",
  'mkt.denied.scope.body':
    'It asked twice and was refused both times, so it stopped rather than keep asking. Nothing was installed and nothing was charged.',
  'mkt.denied.scope.action': 'COPY DETAILS'
} as const

/**
 * Verification refusals. UNVERIFIABLE and INVALID are deliberately unalike:
 * one is an accusation, the other is nobody's fault, and the buyer's next move
 * differs. Rendering them in one voice would libel an author whose only crime
 * is shipping ahead of the buyer's build.
 */
export const MKT_BLOCKED = {
  'mkt.review.blocked.signature_invalid.title': "This preset doesn't match its signature",
  'mkt.review.blocked.signature_invalid.body':
    'It may have been altered since {author} published it. Nothing was installed.',
  'mkt.review.blocked.signature_invalid.action': 'REPORT TO {author}',

  'mkt.review.blocked.schema_unsupported.title': 'This preset needs a newer Cookrew',
  'mkt.review.blocked.schema_unsupported.body':
    "It was built for a later preset format, so this version can't check it. Nothing was installed.",
  'mkt.review.blocked.schema_unsupported.action': 'UPDATE COOKREW',

  'mkt.review.blocked.hash_mismatch.title': "This download doesn't match what was published",
  'mkt.review.blocked.hash_mismatch.body':
    'The file changed in transit or in storage. Nothing was installed.',
  'mkt.review.blocked.hash_mismatch.action': 'RETRY DOWNLOAD',

  'mkt.review.blocked.report_mismatch.title': 'This preset contains more than it declares',
  'mkt.review.blocked.report_mismatch.body':
    "Its safety report doesn't match the team inside it. Nothing was installed.",
  'mkt.review.blocked.report_mismatch.action': 'REPORT TO {author}',

  'mkt.review.blocked.unsigned.title': "This preset isn't signed",
  'mkt.review.blocked.unsigned.body':
    'Cookrew only installs presets an author signed. Nothing was installed.',
  'mkt.review.blocked.unsigned.action': 'REPORT TO {author}',

  'mkt.review.blocked.malformed_team.title': "This preset couldn't be read",
  'mkt.review.blocked.malformed_team.body': 'Its team file is damaged. Nothing was installed.',
  'mkt.review.blocked.malformed_team.action': 'RETRY DOWNLOAD'
} as const

/**
 * EXPORT SAFETY — the sentence that unblocks the feature.
 *
 * "If I export this agent, do strangers get my conversation?" is the number-one
 * reason not to export. version-pin.ts has guaranteed the answer since the day
 * it was written; no surface has ever said it to an author. A guarantee the
 * user cannot see does not change their behaviour.
 */
export const MKT_EXPORT = {
  'mkt.export.safety':
    'Callers get a copy. Your original conversation is never touched, never sent, and never resumed by anyone else.',
  'mkt.export.scrub':
    'Cookrew strips secrets and folder paths before anything is published, and shows you the report first.',
  'mkt.export.pin':
    'A copy was cut here. This is what callers get; your live session carries on above it.',
  'mkt.export.access.none': 'Nobody can call this',
  'mkt.export.access.some': '{n} callers',
  /** R23 bounds this claim: hash-chained, unwitnessed. Say exactly that. */
  'mkt.export.log':
    "A public record of every publish. It shows if a past entry was changed; it can't prove an author is honest."
} as const

export type MktAuthId = keyof typeof MKT_AUTH
export type MktPayId = keyof typeof MKT_PAY
export type MktInstallPriceId = keyof typeof MKT_INSTALL_PRICE
export type MktDeniedReasonId = keyof typeof MKT_DENIED_REASONS
export type MktBlockedId = keyof typeof MKT_BLOCKED
export type MktExportId = keyof typeof MKT_EXPORT

/** Pricing as a buyer reads it, for the buy sheet and the install page alike. */
export interface PriceLike {
  model: 'one-time' | 'per-call'
  amount: string
  asset: string
}

/**
 * The install page's price line. A free preset says "Free." and stops — an
 * absent price rendered as an empty slot is how a stranger concludes the number
 * is being hidden from them.
 */
export function installPriceLine(pricing: PriceLike | undefined | null, author: string): string {
  if (!pricing) return MKT_INSTALL_PRICE['mkt.install.price.free']
  const id: MktInstallPriceId =
    pricing.model === 'per-call' ? 'mkt.install.price.percall' : 'mkt.install.price.onetime'
  return fillCopy(MKT_INSTALL_PRICE[id], {
    price: pricing.amount,
    asset: pricing.asset,
    author: authorLabel(author)
  })
}

/** What the buyer is buying, one line, chosen by the model. */
export function purchaseModelLine(pricing: PriceLike): string {
  return pricing.model === 'per-call'
    ? MKT_PAY['mkt.pay.model.percall']
    : MKT_PAY['mkt.pay.model.onetime']
}

/**
 * The 403 a buyer sees, resolved from the reason the gate sent.
 *
 * An unrecognised reason falls to the unknown pair rather than rendering the
 * token — the forward-compatibility rule, which has already paid out once when
 * `scope` was added after clients shipped.
 */
export function denialCopy(
  reason: string,
  remedy: string | undefined,
  vars: Readonly<Record<string, string | number>> = {}
): { title: string; body: string; action: string } {
  const title = `mkt.denied.${reason}.title` as MktDeniedReasonId
  if (!(title in MKT_DENIED_REASONS)) return unknownDenialCopy(remedy)
  const at = (suffix: string): string =>
    fillCopy(MKT_DENIED_REASONS[`mkt.denied.${reason}.${suffix}` as MktDeniedReasonId], vars)
  return { title: at('title'), body: at('body'), action: at('action') }
}

/** A verification refusal, resolved from the token the installer returned. */
export function blockedCopy(
  reason: string,
  vars: Readonly<Record<string, string | number>> = {}
): { title: string; body: string; action: string } | null {
  const key = `mkt.review.blocked.${reason}.title` as MktBlockedId
  if (!(key in MKT_BLOCKED)) return null
  const at = (suffix: string): string =>
    fillCopy(MKT_BLOCKED[`mkt.review.blocked.${reason}.${suffix}` as MktBlockedId], vars)
  return { title: at('title'), body: at('body'), action: at('action') }
}

/**
 * ── R31: TWO IDENTITY VOCABULARIES, AND THE WALL BETWEEN THEM ────────────────
 *
 * The product now has two ways a person proves who they are, and they are for
 * different relationships:
 *
 *   ACCOUNTS — the PUBLIC door. A stranger at /svc/, the install page, the
 *   marketplace, any 401. They and the author have never met; the account is
 *   what a registry can check.
 *
 *   SIX WORDS — between TWO HUMANS WHO ALREADY KNOW EACH OTHER. WHO CAN CALL on
 *   a LAN, owner to caller, compared out loud over a channel we do not control.
 *   No registry is involved and none could help.
 *
 * THEY MUST NOT BLEED. The failure is not aesthetic: if the enrolment ceremony
 * starts talking about accounts, a person will look for a registry to vouch for
 * a key that no registry has ever seen, and the comparison — the only thing
 * that makes enrolment safe — starts to feel like a formality someone else has
 * already handled. Conversely, an account sheet showing a fingerprint invites a
 * stranger to verify something against nobody.
 *
 * The rule, and `identityVocabularyLeaks()` below enforces it: an account
 * string never mentions words, fingerprints or reading aloud; a six-word string
 * never mentions accounts or signing in. They may not appear in one sheet.
 */

/** The six-word ceremony. LAN, human-to-human. No account vocabulary, ever. */
export const MKT_ENROL = {
  'mkt.enrol.title': 'Read these to each other',
  'mkt.enrol.body':
    'You should both see the same six words. Same words means the same key. Different words means stop — you are not enrolling the key you think you are.',
  'mkt.enrol.channel': 'Say them out loud on a call, not over this connection.',
  /** The owner's act: the label states the claim the click makes. */
  'mkt.enrol.action.owner': 'I COMPARED THESE · ENROL',
  /** The caller's act. Different verb, because they enrol nobody. */
  'mkt.enrol.action.caller': 'I READ THESE ALOUD · CONNECT',
  'mkt.enrol.dismiss': 'Cancel',
  /** The one wrong paste that is a security event rather than a typo. */
  'mkt.enrol.paste.private':
    "That's a private key — don't share it. Cookrew hasn't stored it. Ask them for their public key, and if it went over a channel someone else can read, they should replace the pair.",
  'mkt.enrol.paste.notakey': "That doesn't look like a public key.",
  'mkt.enrol.paste.wrongtype': "That's a {type} key. Cookrew callers use ed25519.",
  'mkt.enrol.paste.malformed':
    'That key is incomplete — it may have been cut off when copied.',
  'mkt.enrol.paste.duplicate': 'You already enrolled this key as {name}.'
} as const

/** Saving to the account (R31). Private is the load-bearing word. */
export const MKT_SAVE = {
  'mkt.save.action': 'SAVE TO MY PRESETS',
  /** The toast. "Private" answers the fear that makes the button hesitate. */
  'mkt.save.done': 'Saved to your account, private. Nothing was published.',
  'mkt.save.error': "Couldn't save that — nothing was stored and nothing was published."
} as const

export type MktEnrolId = keyof typeof MKT_ENROL
export type MktSaveId = keyof typeof MKT_SAVE

/** Account vocabulary — the public door. */
const ACCOUNT_WORDS = /\baccount\b|\bsign(ed|ing)? in\b|\bsign in\b/i
/** Ceremony vocabulary — two humans who know each other. */
const CEREMONY_WORDS = /\bsix words\b|\bfingerprint\b|\bread (these|them) (aloud|to)\b|\bout loud\b/i

/**
 * R31's wall, as a function so a test can hold it.
 *
 * Returns the ids where the two identity vocabularies appear in ONE string.
 * Empty is the only acceptable answer: a sentence that reaches for both is a
 * sentence that has confused a registry check with a conversation between two
 * people, and that confusion is exactly what makes one of them unsafe.
 */
export function identityVocabularyLeaks(
  strings: Readonly<Record<string, string>>
): string[] {
  return Object.entries(strings)
    .filter(([, v]) => ACCOUNT_WORDS.test(v) && CEREMONY_WORDS.test(v))
    .map(([id]) => id)
}

/** Every group, so a renderer can resolve any id without knowing its family. */
export const MKT_ALL = {
  ...MKT_ROTATION,
  ...MKT_DENIED,
  ...MKT_AUTH,
  ...MKT_PAY,
  ...MKT_INSTALL_PRICE,
  ...MKT_DENIED_REASONS,
  ...MKT_BLOCKED,
  ...MKT_EXPORT,
  ...MKT_ENROL,
  ...MKT_SAVE
} as const

export type MktId = keyof typeof MKT_ALL

/** Resolve any id and fill it. Throws on an unknown id, like fillCopy does on
 *  an unfilled placeholder: both are programming mistakes, not user states. */
export function copy(id: MktId, vars: Readonly<Record<string, string | number>> = {}): string {
  const template = MKT_ALL[id]
  if (template === undefined) throw new Error(`marketplace copy: unknown id ${id}`)
  return fillCopy(template, vars)
}
