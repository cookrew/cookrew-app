/** Types for the dependency-free CDP client, for the perf gate that imports it. */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> & { result?: { value?: unknown } }>
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void
  close(): void
}
export function chromeBinary(): string | null
export function launchChrome(options: { userDataDir: string; headless?: boolean; extraArgs?: string[] }): Promise<{
  child: { kill(signal?: string): void; exitCode: number | null }
  port: number
  browserWs: string
}>
export function pageTarget(port: number): Promise<string>
export function connectCdp(wsUrl: string, options?: { connectTimeoutMs?: number; commandTimeoutMs?: number }): Promise<CdpClient>
