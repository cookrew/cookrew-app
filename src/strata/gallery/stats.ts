// Bytes and element counts per figure, against the lane's budgets.
import type { FigureArt } from '../../shared/strata'

export type Family = 'machine' | 'container' | 'avatar' | 'card'

export const BUDGETS: Record<Family, number> = {
  machine: 12 * 1024,
  container: 10 * 1024,
  avatar: 1.5 * 1024,
  card: 1.5 * 1024
}

interface Row {
  family: Family
  label: string
  bytes: number
  elements: number
}

const rows = new Map<string, Row>()

export const elementsOf = (svg: string): number => (svg.match(/<[a-zA-Z]/g) ?? []).length

/** Note a drawn figure once per family + label. */
export const record = (family: Family, label: string, art: FigureArt): FigureArt => {
  rows.set(`${family}:${label}`, { family, label, bytes: art.svg.length, elements: elementsOf(art.svg) })
  return art
}

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

export const summary = () =>
  (Object.keys(BUDGETS) as Family[]).map((family) => {
    const of = [...rows.values()].filter((r) => r.family === family)
    const biggest = of.reduce<Row | null>((a, r) => (!a || r.bytes > a.bytes ? r : a), null)
    const busiest = of.reduce<Row | null>((a, r) => (!a || r.elements > a.elements ? r : a), null)
    const mean = of.length ? of.reduce((s, r) => s + r.bytes, 0) / of.length : 0
    return { family, count: of.length, budget: BUDGETS[family], biggest, busiest, mean, over: of.filter((r) => r.bytes > BUDGETS[family]) }
  })
