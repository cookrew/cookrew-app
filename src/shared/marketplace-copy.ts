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
