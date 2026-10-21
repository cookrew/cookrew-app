export interface MockSwitches {
  readonly auth: boolean
  readonly storm: readonly string[]
  readonly hang: readonly string[]
}
export interface MockRefusal {
  readonly status: number
  readonly body: { readonly error: string; readonly message: string }
}
export const MOCK_SWITCHES: MockSwitches
export function mockToken(machineId: string): string
export function nextSwitches(current: MockSwitches, body: unknown): MockSwitches
export function tokenOf(headers: { authorization?: string }, url: URL): string | null
export function gate(switches: MockSwitches, request: { machineId: string; api: boolean; token: string | null }): 'hang' | MockRefusal | null
