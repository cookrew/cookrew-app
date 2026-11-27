// Types for cli/host/alma.mjs (the Alma backend), read by tests/alma-backend.test.ts.

export interface AlmaResult<T = unknown> {
  status: number
  body: T
}

export class AlmaApi {
  constructor(baseUrl: string)
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<AlmaResult<T>>
}

export interface AlmaEvents {
  session?: (opened: { id: string; resumed: boolean }) => void
  model?: (state: { model: string; effort: string }) => void
  text?: (message: string, text: string) => void
  thought?: (message: string, text: string) => void
  tool?: (id: string, title: string, about: string) => void
  toolDone?: (id: string, status: string, output: string) => void
  permissionRecord?: (ask: { about: string; options: string[] }) => void
  permission?: (ask: { about: string; options: Array<{ id: string; name: string }> }) => Promise<number | null>
  answered?: (name: string) => void
  notice?: (message: string) => void
}

export interface AlmaBackendOptions {
  baseUrl: string
  model?: string
  effort?: string
  cwd: string
  events: AlmaEvents
}

export class AlmaBackend {
  constructor(options: AlmaBackendOptions)
  open(options: { resume?: string }): Promise<{ id: string; resumed: boolean }>
  prompt(text: string): Promise<{ stop: string }>
  cancel(): Promise<boolean>
  close(): void
}
