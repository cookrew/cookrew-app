import { MKT_GATE } from '../shared/marketplace-copy'

export interface CrewLineTarget {
  origin: string
  slug: string
}

/**
 * Build the placed card's command. Payment references are deliberately absent:
 * crew-line may send X-Payment only after its caller types `/pay` in that live
 * process, never from a persisted chip value left over from an earlier quote.
 */
export function crewLineCommand(script: string, crew: CrewLineTarget): string {
  const args = [
    script,
    '--origin',
    crew.origin,
    '--slug',
    crew.slug,
    '--payment-unavailable-copy',
    MKT_GATE['mkt.gate.payment.unavailable'],
    '--payment-unverifiable-copy',
    MKT_GATE['mkt.gate.payment.unverifiable']
  ]
  return `node ${args.map((value) => JSON.stringify(value)).join(' ')}`
}
