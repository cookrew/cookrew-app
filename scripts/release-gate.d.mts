export function tagProblem(tag: string, version: string): string | null
export function isPrerelease(tag: string): boolean
export function missingAssets(names: readonly string[], version: string): string[]
export function branchProblem(facts: {
  tag: string
  onMain: boolean
  parents: readonly string[]
  mergedFromDev: boolean
}): string | null
