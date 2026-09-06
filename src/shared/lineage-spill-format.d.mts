/** Types for src/shared/lineage-spill-format.mjs (see that file for WHY). */

export interface SpillRecord {
  version: number
  terminalId: string
  /** Every session id ever bound to this node, oldest first. Append-only. */
  ids: string[]
  /** id → ISO timestamp of when it was first recorded. */
  boundAt: Record<string, string>
}

export declare const SPILL_VERSION: number
export declare const SPILL_DIR_NAME: string
export declare function isSpillableId(terminalId: unknown): boolean
export declare function spillFileName(terminalId: string): string | null
export declare function emptySpill(terminalId: string): SpillRecord
export declare function unionLineage(
  ...lists: readonly (readonly string[] | undefined | null)[]
): string[]
export declare function parseSpill(text: string, terminalId: string): SpillRecord
export declare function mergeSpill(
  record: SpillRecord,
  ids: readonly string[],
  at: string
): { record: SpillRecord; appended: string[] }
export declare function serializeSpill(record: SpillRecord): string
