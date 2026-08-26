/** Payment rails a served-crew surface is allowed to name. */
export type ServedPaymentRail = 'x402' | 'stripe'

/**
 * Read the rail menu from the same opaque quote the gate returns.
 *
 * The surface deliberately learns only stable identifiers. It never receives
 * pay-to addresses, Checkout URLs, facilitator configuration, or secrets.
 */
export function servedPaymentRails(terms: unknown): readonly ServedPaymentRail[] {
  if (typeof terms !== 'object' || terms === null) return []
  const accepts = (terms as { accepts?: unknown }).accepts
  if (!Array.isArray(accepts)) return []

  const rails: ServedPaymentRail[] = []
  for (const entry of accepts) {
    if (typeof entry !== 'object' || entry === null) continue
    const { scheme, network } = entry as { scheme?: unknown; network?: unknown }
    const rail =
      scheme === 'stripe-checkout' && network === 'stripe'
        ? 'stripe'
        : scheme === 'exact'
          ? 'x402'
          : null
    if (rail !== null && !rails.includes(rail)) rails.push(rail)
  }
  return rails
}
