export const CONSOLE_HOST_MARK: string
export function consolePolicy(input: { api: string; local?: boolean }): string
export function consoleHeaders(input: { api: string; local?: boolean }): string
export function firstLoad(html: string): string[]
export function fontsNamed(css: string): string[]
export function withIntegrity(html: string, read: (path: string) => Uint8Array | null): string
