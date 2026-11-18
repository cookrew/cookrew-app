// Types for the parts of scripts/perf-budgets.mjs that tests import.
import type { Budget, ZoomMotionBudgets } from './perf-eval-lib.mjs'

export const BUDGETS: {
  dom: ZoomMotionBudgets & Record<string, Budget | Record<string, Budget>>
  remote: Record<string, Budget>
  [section: string]: unknown
}
