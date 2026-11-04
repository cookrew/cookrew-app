/**
 * Types for the part of scripts/copilot-daily-ops.mjs its test reaches, so the
 * test type-checks under tsconfig.node.json.
 */
import type { ChildProcess } from 'node:child_process'

export function collectLane(input: { repo: string; lane: string; tree: string; subject: string; body: string }): boolean
export function safeMerge(input: { repo: string; branch: string; message: string }): { merged: boolean; reason: string }
export function stopGroup(child: ChildProcess, graceMs?: number): void
