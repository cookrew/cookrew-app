/**
 * A pane's guard (line-guard.mjs). Without options: hand it each frame another machine sent and print what it
 * answers. With `typed`: hand it what was typed into the pane and forward what it answers.
 */
export function clipboardGuard(options?: { typed?: boolean }): (chunk: string) => string
/** Words another machine sends for a program to say: no control survives, at most a line. */
export function plainText(value: unknown): string
