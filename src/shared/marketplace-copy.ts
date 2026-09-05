import type { ServedPaymentRail } from './served-payment-rails'

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
  'mkt.pay.credit.skip': 'Top up any time from the chip.',

  /**
   * ── THE RAILS, as chips ───────────────────────────────────────────────────
   * A door may take a card, USDC, or both. The chip row is the choice, so each
   * label says the instrument, and the wallet one says WHOSE wallet — a person
   * about to sign should never wonder which key is about to move money.
   */
  'mkt.pay.rail.card': 'CARD',
  'mkt.pay.rail.usdc': 'USDC · {wallet}',
  'mkt.pay.rail.usdc.nowallet': 'USDC — NO WALLET HERE',
  /** The card hand-off. It leaves the app on purpose; say so before it does. */
  'mkt.pay.card.handoff':
    'Your card is entered on Stripe’s own page, in your browser — never in Cookrew.',
  'mkt.pay.card.waiting.title': 'Waiting for your card payment',
  'mkt.pay.card.waiting.body':
    'Finish on the Stripe page that just opened. This unlocks itself when it lands — you can leave it.',
  /** A settle the door refused: the accusation voice, per R-two-voices. */
  'mkt.pay.error.invalid.title': "That payment didn't verify",
  'mkt.pay.error.invalid.body':
    'The door checked it and would not take it, so no session was started. Nothing was charged by us.',
  /** Our checker could not answer: the apology voice. Never "declined". */
  'mkt.pay.error.unverifiable.title': "We couldn't check that payment",
  'mkt.pay.error.unverifiable.body':
    'Your payment may be perfectly fine — our checker could not reach a verdict. Trying again will not charge you twice.',
  /** No wallet provisioned on this device. Not a refusal — a missing tool. */
  'mkt.pay.error.nowallet.title': 'No wallet on this device',
  'mkt.pay.error.nowallet.body':
    'Cookrew never holds keys, so it can only sign with a wallet you set up here. Pay by card instead, or set one up and come back.'
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
  'mkt.denied.scope.action': 'COPY DETAILS',

  /**
   * ── A SERVED DOOR's refusals ──────────────────────────────────────────────
   * Someone else's team, on their machine, on their terms. Each of these is a
   * state the served gate can actually answer with, and each says the same two
   * things the rest of this block says: what did NOT happen to your money, and
   * the one move that is yours.
   */

  /** 429 — the OWNER's lent budget, not the caller's payment. Nothing to buy. */
  'mkt.denied.budget.title': 'This team is out of sessions',
  'mkt.denied.budget.body':
    'Its owner lends it a fixed number and they are used up. Nothing was charged — a payment now would buy a session that cannot start.',
  'mkt.denied.budget.action': 'ASK ITS OWNER',

  /** 503 — a paid door with no working rail. Refusing to quote, not to serve. */
  'mkt.denied.payment_unavailable.title': "This team can't take payment right now",
  'mkt.denied.payment_unavailable.body':
    'It asks to be paid but has no working way to accept it, so nothing was charged and no session was started.',
  'mkt.denied.payment_unavailable.action': 'TRY LATER',

  /** 403 — the credential is for another door. Ours to explain, not theirs. */
  'mkt.denied.workspace.title': "That sign-in isn't for this door",
  'mkt.denied.workspace.body':
    'The credential belongs to a different team. Nothing was charged. Opening the address again signs you in to the right one.',
  'mkt.denied.workspace.action': 'START AGAIN',

  /** 503 — admitted, but the team did not come up. Never the caller's fault. */
  'mkt.denied.not_answering.title': 'This team is not answering',
  'mkt.denied.not_answering.body':
    'The door is up but its orch did not start, so no session began. Nothing was charged.',
  'mkt.denied.not_answering.action': 'TRY AGAIN'
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
  /** Singular has its own key. My own §7 rule bans "(s)" and mandates "1 agent /
   *  4 agents"; shipping only the plural made one caller read "1 callers" and
   *  forced every call site to branch locally. Use accessLabel(). */
  'mkt.export.access.one': '1 caller',
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

/**
 * ── R30: TEMPLATE · SERVE · SESSION ──────────────────────────────────────────
 *
 * Three words a stranger must survive without a glossary. TEMPLATE needs no
 * gloss — "a starting point you copy from" is the right guess. SERVE is jargon
 * alone but is taught by its own success state, so every surface here carries
 * "takes calls" beside it rather than only the live one. SESSION is OWNER-SIDE
 * ONLY: a stranger's session is a login, weightless and ephemeral, and this one
 * is a workspace with a folder that parks for hours and survives the author's
 * next version. A caller has a WORKSPACE and mostly needs no noun at all — no
 * string in MKT_SVC uses the word, and a test holds that.
 *
 * "Service" is deliberately absent as a noun: a fourth word the bar has no
 * budget for. /svc/ survives only as a URL, because nobody reads a path as
 * vocabulary.
 */

/** Saving a workspace as a template. R31: it saves to the account, privately. */
export const MKT_TEMPLATE = {
  'mkt.template.action': 'SAVE AS TEMPLATE',
  'mkt.template.what':
    'Saves this workspace as it is right now — roles, prompts, connections — and pins the version on the rail.',
  'mkt.template.done': 'Saved to your account, private. Nothing was published.',
  /** JUST ME, not MINE: everything on the shelf is mine, published or not. The
   *  state being drawn is NOT SHARED, and JUST ME is the same words as the
   *  serve sheet's first row — one vocabulary for the tag and the answer. */
  'mkt.template.chip.private': 'JUST ME',
  'mkt.template.chip.tip': 'Only you can see this. Serve it when you want other people to use it.',
  'mkt.template.error': "Couldn't save that — nothing was stored and nothing was published.",
  'mkt.template.newversion':
    'Saved as {version}. New callers start here; anyone already working stays on the version they started with.'
} as const

/** The SERVE sheet — one question, three rows, no per-agent matrix. */
export const MKT_SERVE = {
  'mkt.serve.title': 'Serve {templateName}',
  'mkt.serve.door':
    'Callers talk to {orch} only. It runs the rest of the team the way it always has — the others are never exposed.',
  'mkt.serve.who': 'Who can call it?',
  'mkt.serve.who.none': 'Just me',
  'mkt.serve.who.none.sub': "Stays on your shelf. That's where it is now.",
  /** R31 makes the plain label the true one; my earlier objection to "signs in"
   *  is withdrawn — it was right for facts that have since changed. */
  'mkt.serve.who.free': 'Anyone with a Cookrew account — free',
  /** The R30 privacy ruling narrowed the claim: identity only. The old tail —
   *  "never what they are doing" — promised privacy-from-owner, which the
   *  architecture cannot keep (their session runs in the owner's app). */
  'mkt.serve.who.free.sub': 'They sign in, then start.',
  'mkt.serve.who.paid': 'Anyone who pays',
  'mkt.serve.who.paid.sub':
    'Set a price. Callers pay you directly — Cookrew never holds the money and takes nothing.',
  'mkt.serve.price.unit': 'USD · per session',
  'mkt.serve.price.label': 'Price in USD per session',
  'mkt.serve.price.paid': '{price} USD · per session · {rails}',
  'mkt.serve.price.free': 'free · sign in to start',
  'mkt.serve.rails.live': 'Offers {rails}',
  'mkt.serve.rails.none': 'No payment rail is configured yet.',
  'mkt.serve.rails.none.short': 'no payment rail configured',
  'mkt.serve.payment.required': 'A paid door needs at least one way to pay you.',
  'mkt.serve.payment.live-blocked': '{templateName} needs a way to get paid.',
  'mkt.serve.payment.setup': 'Set up ways to get paid',
  'mkt.serve.payment.title': 'Ways to get paid',
  'mkt.serve.payment.subtitle':
    'Choose either one or both. Callers pay you directly — Cookrew never holds the money.',
  'mkt.serve.payment.usdc.title': 'USDC on Base',
  'mkt.serve.payment.usdc.label': 'USDC receiving address',
  'mkt.serve.payment.usdc.hint':
    'This 0x address is public and appears in the payment request shown to callers.',
  'mkt.serve.payment.usdc.ready': 'USDC rail: configured',
  'mkt.serve.payment.usdc.save': 'SAVE ADDRESS',
  'mkt.serve.payment.stripe.title': 'Card with Stripe',
  'mkt.serve.payment.stripe.label': 'Stripe secret key',
  'mkt.serve.payment.stripe.hint':
    'Write-only: Cookrew stores this at 0600, clears this field, and never shows the key again.',
  'mkt.serve.payment.stripe.ready': 'Card rail: configured ({mode})',
  'mkt.serve.payment.stripe.save': 'SAVE KEY',
  'mkt.serve.payment.invalid-pay-to': 'Enter a 0x address with 40 hexadecimal characters.',
  'mkt.serve.payment.invalid-stripe-key':
    'Paste a Stripe secret key beginning sk_test_ or sk_live_.',
  'mkt.serve.payment.write-failed':
    "Couldn't save that on this machine. The previous payment setup is unchanged.",
  'mkt.serve.rail.x402': 'USDC',
  'mkt.serve.rail.stripe': 'card',
  /** The bound the reversibility promise needs, or it reads as a recall. */
  'mkt.serve.reversible':
    'Change this any time, including back to Just me — which stops new callers. Anyone already working keeps going until you end them.',
  'mkt.serve.action': 'START SERVING',
  'mkt.serve.dismiss': 'Cancel',
  /** THE OWNER REASSURANCE. Not "safe" but "carry on", which is the real fear. */
  'mkt.serve.safety':
    "Callers never touch your workspace. Each one gets a fresh copy of the template you pinned, in its own folder. Keep working exactly as you did before — they can't see it, and nothing you do now reaches them.",
  'mkt.serve.live': '{templateName} is taking calls.',
  'mkt.serve.live.address': 'Callers land on {orch} · {priceLine}',
  /** The hand-off: what the owner DOES with the address they were just shown. */
  'mkt.serve.live.handoff':
    'Hand this address to a caller — in their Cookrew it goes under TERMINAL → + IMPORT.',
  /**
   * WHO CAN OPEN THIS LINK — the one question an owner should be asked about
   * serving, and the one the card could not answer.
   *
   * It is about REACHING the door, never about getting in: the sign-in, the
   * price and the owner's own lending limit are all still ahead. Blurring the
   * two would tell someone their paid door is open to anyone, which is a
   * sentence about entitlement wearing the clothes of a sentence about
   * networks.
   *
   * These say who, not how. The transport is ours to solve; "who can reach
   * this?" is the owner's whole concern.
   */
  'mkt.serve.reach.lan': 'Only people on this network can open it.',
  'mkt.serve.reach.tailnet': 'Only people on your tailnet can open it.',
  'mkt.serve.reach.public': 'Anyone with the link can open it.',
  'mkt.serve.reach.relay': 'Anyone with the link can open it.',
  /** Said beside the reach line when the door is not reachable from outside —
   *  the fix, not a scolding, because the owner did nothing wrong. */
  'mkt.serve.reach.narrow.why':
    'Sending it further needs a way in from outside — turn on Tailscale, or serve it through cookrew.dev.',
  'mkt.serve.stop.action': 'STOP SERVING',
  'mkt.serve.stop.confirm':
    'Stop serving {templateName}? {n} workspaces end now, including any mid-call. The template stays on your shelf.',
  'mkt.serve.error': "Couldn't start serving — {templateName} is still private and nobody can call it.",
  /**
   * THE NO-ORCH REFUSAL, said at save rather than discovered at the gate.
   *
   * A crew with no orch used to save and serve, and the first caller's prompt
   * was typed at a bare zsh prompt. The sentence has to do two jobs: name the
   * missing thing in the owner's own vocabulary (the ◆ orch badge on a card),
   * and say what it is FOR — otherwise "pick an orch" reads as a form field
   * rather than the reason the crew cannot answer anybody.
   */
  'mkt.serve.no-orch':
    'Pick an orch before you serve this — callers talk to exactly one agent, and this crew has none. Mark one card as the orch and it becomes the door.',
  /** The gate's reasons, in the owner's words. Keyed by ServeRefusal. */
  'mkt.serve.refused.bad-price': 'A paid door needs a price above zero.',
  'mkt.serve.refused.priced-free-door': 'A free door cannot carry a price.',
  'mkt.serve.refused.grant-unusable':
    'Not taking callers — this crew’s orch could not answer one check with the credential it was lent. Match the grant to the orch, or fix the endpoint’s request template.',
  /** The remote transport's standing refusal: publish is owner-IPC only (the
   *  grant-surface rule), so a phone can save a team but never open a door. */
  'mkt.serve.refused.desktop-only':
    'a door opens from the desktop app, never from this remote screen. Save the team again on the desktop to start taking callers.'
} as const

/** The SESSIONS table. Owner-side; the word lives here and nowhere else. */
export const MKT_SESSIONS = {
  'mkt.sessions.title': '{templateName} · sessions',
  'mkt.sessions.subtitle': 'Each one is a standalone workspace in your app.',
  'mkt.sessions.col.caller': 'Caller',
  'mkt.sessions.col.workspace': 'Workspace',
  'mkt.sessions.col.sandbox': 'Sandbox',
  'mkt.sessions.col.version': 'Version',
  'mkt.sessions.col.state': 'State',
  'mkt.sessions.state.working': 'working',
  /** Parked must say it is free, or an owner ends sessions to save money they
   *  were never spending. */
  'mkt.sessions.state.parked': 'parked {ago} · costs you nothing',
  'mkt.sessions.empty': 'Nobody has called this yet.',
  'mkt.sessions.end.action': 'END',
  /** The one control here that MUST confirm — it destroys someone else's work —
   *  and the confirm carries the consequence rather than asking "are you sure". */
  'mkt.sessions.end.confirm.title': "End {caller}'s workspace?",
  'mkt.sessions.end.confirm.body':
    "Anything it's doing right now stops, and their folder is removed. They'll be told you ended it. Your own workspace and template are untouched.",
  'mkt.sessions.end.confirm.action': 'END IT',
  'mkt.sessions.end.done': "{caller}'s workspace ended.",
  /** Frightening half first, plus the SECOND remedy — the first one is the
   *  thing that just failed. */
  'mkt.sessions.end.error':
    "Couldn't end {caller}'s workspace — it's still running and they can still work. Try again, or stop serving to end every workspace at once."
} as const

/**
 * The /svc/ page — a stranger with no app and no idea what Cookrew is. Four
 * questions in the order they are asked: what is this, who runs it, what does
 * it cost, what happens if I start. Then the Gate Sheet.
 */
export const MKT_SVC = {
  'mkt.svc.document.title': '{templateName} · Cookrew',
  'mkt.svc.eyebrow': 'SERVED CREW',
  'mkt.svc.title': '{templateName}',
  'mkt.svc.byline': 'run by {author} · {n} agents · {version}',
  'mkt.svc.byline.served': '{n} agents · {version}',
  'mkt.svc.what':
    'A crew of AI agents that works on what you ask. You talk to one of them — {orch} — and it runs the others.',
  'mkt.svc.yours':
    'You get your own private workspace. It is created when you start, it belongs to you, and the files you make stay in it. Nobody else’s work touches yours.',
  'mkt.svc.price.paid':
    '{price} {asset} to start. Paid directly to {author} — Cookrew never holds the money and takes nothing.',
  'mkt.svc.price.usd': '{price} USD to start.',
  'mkt.svc.price.free': 'Free to start.',
  'mkt.svc.pay.title': 'Ways to pay',
  'mkt.svc.pay.x402.title': 'USDC',
  'mkt.svc.pay.x402.body':
    'Pay with USDC on Base. Cookrew sends the payment proof when you retry your call.',
  'mkt.svc.pay.stripe.title': 'Card',
  'mkt.svc.pay.stripe.body':
    'Open Stripe Checkout from Cookrew and pay by card. Return here after Stripe confirms it, then retry your call.',
  'mkt.svc.pay.none': 'This crew is not taking new callers right now.',
  'mkt.svc.payment.received': 'Payment received — retry your call in Cookrew.',
  'mkt.svc.open.title': 'Start in Cookrew',
  'mkt.svc.open.account':
    'In Cookrew, choose + IMPORT and paste the address below. You get one card — {orch}’s terminal — and it signs you in when it starts.',
  'mkt.svc.open.paid':
    'In Cookrew, choose + IMPORT and paste the address below. It shows the terms and takes the payment once, before anything is placed — then you get one card, {orch}’s terminal.',
  'mkt.svc.open.address': 'Address',
  'mkt.svc.availability.title': 'Availability',
  /**
   * FLAGGED FOR ATLAS. "They can't see inside it" is a claim about what the
   * product surfaces, not about what is reachable on a machine the author owns.
   * If an author can read a caller's transcript this must say so instead — it
   * is shown before payment, which makes it the most consequential sentence on
   * the page.
   */
  'mkt.svc.privacy':
    "{author} can see that you're here and can end your workspace. They can't see inside it.",
  'mkt.svc.start.paid': 'START — {price} {asset}',
  'mkt.svc.start.free': 'START',
  'mkt.svc.start.note':
    'Starting signs you in first, then takes payment. Nothing is charged until you approve it in your wallet.',
  'mkt.svc.start.note.free': 'Starting signs you in first. Nothing is charged.',
  'mkt.svc.ready': 'Your workspace is ready. Files you create land in your own folder.',
  'mkt.svc.frozen':
    '{author} released {newVersion}. You are on {version}, the one you started with, and it stays that way until you finish.',
  /** FLAGGED: if the sandbox survives END, this must say that instead. Written
   *  bluntly on purpose — a stranger paid, did work, and someone else's button
   *  deleted it. Softening is the temptation and would be the lie. */
  'mkt.svc.ended':
    '{author} ended this workspace. Anything running stopped. Your files were in the workspace and are gone with it.',
  'mkt.svc.ended.paid': 'You paid to start this. Contact {author} if that was not expected.',
  'mkt.svc.unavailable': '{templateName} is not taking calls right now.'
} as const

/** Human labels for structured rail identifiers; prose stays in this module. */
export function servedPaymentRailLabel(rail: ServedPaymentRail): string {
  return rail === 'x402'
    ? MKT_SERVE['mkt.serve.rail.x402']
    : MKT_SERVE['mkt.serve.rail.stripe']
}

export function servedPaymentRailsLabel(rails: readonly ServedPaymentRail[]): string {
  return rails.map(servedPaymentRailLabel).join(' · ')
}

export type MktTemplateId = keyof typeof MKT_TEMPLATE
export type MktServeId = keyof typeof MKT_SERVE
export type MktSessionsId = keyof typeof MKT_SESSIONS
export type MktSvcId = keyof typeof MKT_SVC

/**
 * R30's confinement, as a function a test can hold: "session" is owner-side
 * vocabulary and must never reach a caller. MKT_SVC is the caller's whole
 * surface, so the check is exact rather than heuristic.
 */
export function callerFacingSessionLeaks(strings: Readonly<Record<string, string>>): string[] {
  return Object.entries(strings)
    .filter(([, v]) => /\bsessions?\b/i.test(v))
    .map(([id]) => id)
}


/**
 * ── CHIP PROVENANCE AND THE IMPORTED PIN ─────────────────────────────────────
 *
 * The chip family now carries two different facts in two slots, and they must
 * not be confused for each other:
 *
 *   STATE      — where is this in its life? dashed/JUST ME → versioned → served.
 *   PROVENANCE — whose is it? absent for your own, BY {handle} for someone
 *                else's.
 *
 * They are separate axes. A chip can be your own and unpublished, your own and
 * served, or someone else's and running — and the reader needs both answers at
 * a glance, which is why one tag may not try to carry both.
 */
export const MKT_CHIP = {
  /** Provenance. Absent on your own chips; the absence IS the answer. */
  'mkt.chip.by': 'BY {handle}',
  'mkt.chip.by.tip': '{handle} wrote this crew. You are running their work.',
  /**
   * The imported pin's hover. Two kinds, because the chips doc has two: a copy
   * you bought and keep, and a live line you were granted. "The version you
   * were granted" is wrong on a bought copy — it implies someone can take it
   * back, and nobody can.
   */
  'mkt.chip.pin.bought': "You're on {handle}'s {version} — the version you installed. It stays yours.",
  'mkt.chip.pin.granted':
    "You're on {handle}'s {version} — the version you were granted. {handle} can end the line, and your work stops with it.",
  'mkt.chip.pin.session':
    "You're on {handle}'s {version} — the version you started on. New callers may get a newer one; you stay here until you finish.",
  /** Your own pin, for contrast — the reader must be able to tell them apart. */
  'mkt.chip.pin.own': 'Your {version}, pinned at the checkpoint you saved.'
} as const

export type MktChipId = keyof typeof MKT_CHIP

/** How a caller came by this crew. Drives which pin sentence the hover shows. */
export type ImportKind = 'bought' | 'granted' | 'session'

/**
 * The imported pin's tooltip. A resolver rather than one string, because the
 * three relationships differ in the only way the reader cares about: whether it
 * can be taken away. Bought cannot, granted can, a session ends when the author
 * says so.
 */
export function importedPinTip(
  kind: ImportKind,
  handle: string,
  version: string
): string {
  const id = `mkt.chip.pin.${kind}` as MktChipId
  return fillCopy(MKT_CHIP[id], { handle: authorLabel(handle), version })
}

/**
 * ── THE REMOTE TEAMMATE CARD (Door B) ────────────────────────────────────────
 *
 * A normal terminal card whose binding is a gated remote ask. The design is
 * right and the risk is the same fact: a remote teammate inherits every
 * affordance of a local one, and four of them mean something untrue.
 *
 * Answering the Commander's four questions. Where I differ from the fallbacks,
 * the reason is in the comment — the differences are small in words and load-
 * bearing in what they disclose.
 */

/**
 * Q1 — the rail, where a local card shows checkpoints.
 *
 * The CONTROLS ARE ABSENT, not present-and-refusing: the grant deck's rule
 * holds, a disabled row invites a fight with the wrong control. But absence
 * explains nothing, so the rail is not empty either — it carries the reason the
 * expected thing is missing, and says what the user DOES have. Naming the
 * mechanism ("runs on its owner's machine") is what stops this reading as a
 * missing feature.
 */
export const MKT_REMOTE_RAIL = {
  'mkt.remote.rail.title': 'No checkpoints here',
  'mkt.remote.rail.body':
    "{agent} runs on its owner's machine and keeps its history there. This card holds your calls and the replies you got — nothing before them, and nothing to rewind."
} as const

/**
 * Q2 — access withdrawn mid-turn.
 *
 * NAMING THE OWNER: no. Three reasons, and the third is the one that decided
 * it. The caller was enrolled by the owner, so in the legitimate case they
 * already know who that is and the name adds nothing. In the illegitimate case
 * — a key enrolled by mistake, or a caller who should never have had access —
 * the name is disclosed to precisely the person access was just taken from, and
 * a revocation is often adversarial. And the grant deck's asymmetry says
 * information flows toward LESS exposure on the way out.
 *
 * But "you cannot call this" with no recourse is a dead end, so the copy keeps
 * the channel without the identity: whoever gave you access is a relationship
 * the caller already has, and naming the relationship costs nothing.
 */
export const MKT_REMOTE_REVOKED = {
  /**
   * In flight. This one may be specific: the caller demonstrably had access a
   * second ago, so nothing is disclosed they did not already know. The last
   * clause exists because a card that stops mid-answer reads as a card that
   * lost everything.
   */
  'mkt.remote.revoked.inflight':
    "Your access to {agent} was withdrawn while it was answering. That reply was stopped and won't arrive. Everything above is still here.",
  /**
   * Next attempt. DELIBERATELY IDENTICAL to the generic refusal below — see the
   * note on mkt.remote.refused.cannot. A distinct "you can no longer" line
   * would tell a prober that this agent exists, which is the disclosure Q3's
   * 404 rule exists to prevent.
   */
  'mkt.remote.revoked.recourse': 'If you think that is a mistake, ask whoever gave you access.'
} as const

/**
 * Q3 — five wire answers, FOUR buckets.
 *
 * Not the Commander's three, and the difference matters in both directions.
 *
 * SPLIT OUT: 401 is retryable but NOT by pressing the same button — it needs a
 * ceremony first. Folded into "busy, try again" it makes the user hammer a
 * control that cannot work; folded into "you cannot" it hides a door that is
 * open. It is its own bucket.
 *
 * ADDED: transport failure is not in the five, but the card will meet it more
 * often than some of them, and "unreachable" is emphatically not "refused" —
 * one is our problem and the other is a decision about the caller.
 *
 * MERGED, ON PURPOSE: 403 scope, 403 entitlement/revoked and 404 all render
 * mkt.remote.refused.cannot, WORD FOR WORD. This is the mechanism that makes an
 * unexported agent and a nonexistent one indistinguishable — not careful
 * wording, but a shared string. Vagueness achieved by bucketing survives a
 * refactor; vagueness achieved by two similar sentences does not.
 */
export const MKT_REMOTE_REFUSED = {
  /** 409 busy / not_ready / not_running — retry now, and it may just work. */
  'mkt.remote.refused.busy': '{agent} is busy right now. Try again in a moment.',
  /** 401 — retryable, but only after the ceremony. */
  'mkt.remote.refused.identity': "Prove it's you before calling {agent} — one passkey gesture.",
  'mkt.remote.refused.identity.action': 'USE PASSKEY',
  /**
   * 403 scope · 403 entitlement · 403 revoked · 404. ONE STRING FOR ALL FOUR.
   * It names no cause because every cause it could name is a disclosure.
   */
  'mkt.remote.refused.cannot': 'You cannot call {agent}.',
  /** Not a refusal at all. Ours to fix, and it must not read like a decision. */
  'mkt.remote.refused.unreachable': "Couldn't reach {agent}. Your access is fine — the connection isn't."
} as const

/**
 * Q4 — the cold fork, up to DEFAULT_READY_TIMEOUT_MS before a first byte.
 *
 * YES, say it is one-time: it is true, and it converts a bad first impression
 * into an explained one. The wait is not the problem; an unexplained wait is.
 *
 * The line CHANGES ONCE, and the second stage repeats the one-time fact rather
 * than adding urgency — fifteen seconds in is the moment of maximum doubt, and
 * it is exactly when the reassurance is worth spending again. No countdown: a
 * timer counting toward a failure we are not certain of manufactures dread, and
 * we do not know the real duration, only the ceiling.
 */
export const MKT_REMOTE_WAKING = {
  'mkt.remote.waking.first':
    "Waking {agent} up. The first call to a sleeping agent takes up to half a minute — after that it's quick.",
  'mkt.remote.waking.still': 'Still waking up. This is the slow part, and it only happens once.',
  'mkt.remote.waking.timeout': "{agent} didn't wake up in time. Try again."
} as const

export type MktRemoteRailId = keyof typeof MKT_REMOTE_RAIL
export type MktRemoteRevokedId = keyof typeof MKT_REMOTE_REVOKED
export type MktRemoteRefusedId = keyof typeof MKT_REMOTE_REFUSED
export type MktRemoteWakingId = keyof typeof MKT_REMOTE_WAKING

/** Which of the four buckets a wire answer falls in. The merge IS the privacy. */
export type RemoteRefusal = 'busy' | 'identity' | 'cannot' | 'unreachable'

export function remoteRefusalBucket(status: number, reason?: string): RemoteRefusal {
  if (status === 409) return 'busy'
  if (status === 401) return 'identity'
  if (status === 403 || status === 404) return 'cannot'
  // 5xx, network, timeout — anything that is not the gate answering.
  return 'unreachable'
}

/** The sentence for a refusal. `reason` is accepted and deliberately unused for
 *  the cannot bucket: a call site that passes it must still get one string. */
export function remoteRefusalCopy(
  status: number,
  agent: string,
  reason?: string
): { text: string; retryable: boolean } {
  const bucket = remoteRefusalBucket(status, reason)
  const text = fillCopy(
    MKT_REMOTE_REFUSED[`mkt.remote.refused.${bucket}` as MktRemoteRefusedId],
    { agent }
  )
  return { text, retryable: bucket === 'busy' || bucket === 'identity' }
}

/** Callers, counted without "(s)". */
export function accessLabel(n: number): string {
  if (n <= 0) return MKT_EXPORT['mkt.export.access.none']
  if (n === 1) return MKT_EXPORT['mkt.export.access.one']
  return fillCopy(MKT_EXPORT['mkt.export.access.some'], { n })
}

/**
 * THE GATE SHEET's own receipts and step labels (R28). The deck already owns
 * the FORM strings for each moment — MKT_AUTH asks identity, MKT_PAY asks money,
 * MKT_ENROL runs the ceremony. What the one sheet added is the COLLAPSED line: a
 * step you have cleared becomes a one-line receipt, and those short lines had no
 * home until the sheet existed. They live here so the sheet reads no prose of
 * its own.
 *
 * The two doors keep separate strings so the R31 wall holds by construction: the
 * install receipt speaks accounts, the call receipt speaks the ceremony, and
 * because they are different ids no sheet can render both.
 */
export const MKT_GATE = {
  /** Cleared identity, install door — account vocabulary only. */
  'mkt.gate.identify.install.done': "You're signed in.",
  'mkt.gate.identify.install.why': 'Your Cookrew account, on this device.',
  /** Cleared identity, call door — ceremony vocabulary only. */
  'mkt.gate.identify.call.done': 'You compared the words.',
  'mkt.gate.identify.call.why':
    'Same words, same key — enrolled out loud, never over this connection.',
  /** Served, install door — the copy is placed. */
  'mkt.gate.open.install.title': 'Yours. Placing it on your canvas…',
  'mkt.gate.open.install.why': 'Their originals are untouched — your copy runs against a fork.',
  /** Served, call door — the line is up. */
  'mkt.gate.open.call.title': 'Connected.',
  'mkt.gate.open.call.why': 'Calls run against a fork — their original is never touched.',
  /** Acknowledge the served state and close — the copy is already placed. */
  'mkt.gate.open.action': 'DONE',
  /** The pin you leave with — the violet mark, said in words. */
  'mkt.gate.pin': 'Pinned to your rail',
  'mkt.gate.pin.why': 'Update from the chip when a new version ships — never pushed, always offered.',
  /** Door B's honest wait — a first reply is slow while the line warms. */
  'mkt.gate.warming':
    'First reply can take a moment while the line warms — the card says so; it never just spins.',
  /** No quote existed, so no payment could have been sent or checked. */
  'mkt.gate.payment.unavailable':
    "this crew can't take payment right now — nothing was charged; try later",
  /** A payment was sent, but our facilitator could not give a verdict. */
  'mkt.gate.payment.unverifiable':
    'our checker is unreachable — your payment may be fine; try again shortly.',
  /** The 402 terms block — door-neutral labels, so the sheet reads no prose. */
  'mkt.gate.terms.head': 'Terms — what the gate quoted',
  'mkt.gate.terms.price': 'price',
  'mkt.gate.terms.chain': 'chain',
  'mkt.gate.terms.paidto': 'paid to',
  'mkt.gate.terms.quoteends': 'quote ends',
  /** The AUTHOR chip beside the payee. Uppercased by .cr-chip. */
  'mkt.gate.terms.author': 'author',
  /** The head chip — agent count. */
  'mkt.gate.agents': '{n} agents',
  /** 404 — the resource is not here. Door-neutral; never enrolment prose. */
  'mkt.gate.gone.title': "This isn't here anymore.",
  'mkt.gate.gone.why': 'It may have been unpublished, or the link is wrong. Nothing was installed.',
  /** 5xx / unusable answer — our fault, not theirs. Fails closed to a retry. */
  'mkt.gate.error.title': "Couldn't reach the gate.",
  'mkt.gate.error.why':
    'Something failed on the way — try again in a moment. Nothing was installed or charged.'
} as const

export type MktGateId = keyof typeof MKT_GATE

/** Every group, so a renderer can resolve any id without knowing its family. */
export const MKT_ALL = {
  ...MKT_GATE,
  ...MKT_DENIED,
  ...MKT_AUTH,
  ...MKT_PAY,
  ...MKT_INSTALL_PRICE,
  ...MKT_DENIED_REASONS,
  ...MKT_BLOCKED,
  ...MKT_EXPORT,
  ...MKT_ENROL,
  ...MKT_SAVE,
  ...MKT_TEMPLATE,
  ...MKT_SERVE,
  ...MKT_SESSIONS,
  ...MKT_SVC,
  ...MKT_CHIP,
  ...MKT_REMOTE_RAIL,
  ...MKT_REMOTE_REVOKED,
  ...MKT_REMOTE_REFUSED,
  ...MKT_REMOTE_WAKING
} as const

export type MktId = keyof typeof MKT_ALL

/** Resolve any id and fill it. Throws on an unknown id, like fillCopy does on
 *  an unfilled placeholder: both are programming mistakes, not user states. */
export function copy(id: MktId, vars: Readonly<Record<string, string | number>> = {}): string {
  const template = MKT_ALL[id]
  if (template === undefined) throw new Error(`marketplace copy: unknown id ${id}`)
  return fillCopy(template, vars)
}
