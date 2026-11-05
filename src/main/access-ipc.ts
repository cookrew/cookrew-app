import type { IpcMain } from 'electron'
import { checkEndpoint, type AccessState, type EndpointField, type EndpointInput } from '../shared/agent-access'
import { endpointSource, type AccessStore, type ProbeAnswer } from './agent-access'

/**
 * The endpoint form's channels. Desktop only: the companion has no route to them.
 * The key crosses once, into the secrets store, and is never sent back.
 */

/** A table so tests/ipc-channels.test.ts can read what is registered. */
export const ACCESS_CHANNELS = ['access:state', 'access:save', 'access:clear'] as const

export interface AccessIpcDeps {
  store: AccessStore
  probe: (input: EndpointInput) => Promise<ProbeAnswer>
  /** The source changed: what agents start with, and what the tool check says. */
  onChange?: () => void
}

export type AccessSaveAnswer = { ok: true; state: AccessState } | { ok: false; field: EndpointField; why: string }

export function accessHandlers({ store, probe, onChange }: AccessIpcDeps): {
  state: () => AccessState
  save: (input: unknown) => Promise<AccessSaveAnswer>
  clear: () => AccessState
} {
  return {
    state: () => store.state(),
    save: async (input) => {
      const checked = checkEndpoint(input)
      if (!checked.ok) return checked
      const answer = await probe(checked.value)
      if (!answer.ok) return answer
      store.save(endpointSource(checked.value, answer.wire), checked.value.key)
      onChange?.()
      return { ok: true, state: store.state() }
    },
    clear: () => {
      store.clear()
      onChange?.()
      return store.state()
    }
  }
}

export function registerAccessIpc(ipc: Pick<IpcMain, 'handle'>, deps: AccessIpcDeps): void {
  const handlers = accessHandlers(deps)
  const [state, save, clear] = ACCESS_CHANNELS
  ipc.handle(state, () => handlers.state())
  ipc.handle(save, (_e, input: unknown) => handlers.save(input))
  ipc.handle(clear, () => handlers.clear())
}
