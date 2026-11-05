import type { IpcMain } from 'electron'
import { checkEndpoint, simpleModeHelps, type AccessSimpleAnswer, type AccessState, type EndpointField, type EndpointInput } from '../shared/agent-access'
import { ENDPOINT_COPY } from '../shared/first-run-copy'
import { endpointSource, type AccessStore, type ProbeAnswer } from './agent-access'

/**
 * The endpoint form's channels. Desktop only: the companion has no route to them.
 * The key crosses once, into the secrets store, and is never sent back. An edit
 * leaves the field empty to keep it, and only for the address it was given for.
 */

/** A table so tests/ipc-channels.test.ts can read what is registered. */
export const ACCESS_CHANNELS = ['access:state', 'access:save', 'access:clear', 'access:simple', 'access:simple-offer'] as const

export interface AccessIpcDeps {
  store: AccessStore
  probe: (input: EndpointInput) => Promise<ProbeAnswer>
  /** The source changed: what agents start with, and what the tool check says. */
  onChange?: () => void
  /** Start a card again, so it picks up what changed; false when it could not be done. */
  respawn?: (terminalId: string) => Promise<boolean>
  /** What a card runs on: its preset, and whether the endpoint is what it reaches. */
  cardOf?: (terminalId: string) => { preset: string; direct: boolean } | null
}

/** `moved`: the address changed, and agents still running were on the old one. */
export type AccessSaveAnswer = { ok: true; state: AccessState; moved: boolean } | { ok: false; field: EndpointField; why: string }

const originOf = (url: unknown): string | null => {
  try {
    return new URL(String(url ?? '').trim()).origin
  } catch {
    return null
  }
}

/** The form as main will check it: an empty key on an edit is the saved key, for the saved address alone. */
function withSavedKey(input: unknown, store: AccessStore): { input: unknown } | { refused: AccessSaveAnswer } {
  const form = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const key = store.savedKey()
  const source = store.active()
  if (typeof form.key === 'string' && form.key.trim() !== '') return { input }
  if (key === null || source === null) return { input }
  // No address to compare: checkEndpoint names that, ahead of any word about the key.
  const origin = originOf(form.baseUrl)
  if (origin === null) return { input }
  if (origin === originOf(source.baseUrl)) return { input: { ...form, key } }
  return { refused: { ok: false, field: 'key', why: ENDPOINT_COPY.KEY_NEW_ADDRESS(new URL(source.baseUrl).host) } }
}

export function accessHandlers({ store, probe, onChange, respawn, cardOf }: AccessIpcDeps): {
  state: () => AccessState
  save: (input: unknown) => Promise<AccessSaveAnswer>
  clear: () => AccessState
  simple: (input: unknown) => Promise<AccessSimpleAnswer>
  simpleOffer: (terminalId: unknown) => boolean
} {
  return {
    state: () => store.state(),
    save: async (input) => {
      const filled = withSavedKey(input, store)
      if ('refused' in filled) return filled.refused
      const checked = checkEndpoint(filled.input)
      if (!checked.ok) return checked
      const answer = await probe(checked.value)
      if (!answer.ok) return answer
      const before = store.active()
      store.save(endpointSource(checked.value, answer.wire), checked.value.key)
      onChange?.()
      return { ok: true, state: store.state(), moved: before !== null && originOf(before.baseUrl) !== originOf(checked.value.baseUrl) }
    },
    clear: () => {
      store.clear()
      onChange?.()
      return store.state()
    },
    // The address, key and model are the ones already proved, so no new request goes out.
    simple: async (input) => {
      const { terminalId } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const source = store.active()
      if (source === null || typeof terminalId !== 'string') return { ok: false }
      store.update({ ...source, simple: true })
      onChange?.()
      const restarted = (await respawn?.(terminalId)) === true
      return { ok: true, restarted, state: store.state() }
    },
    simpleOffer: (terminalId) => {
      const card = typeof terminalId === 'string' ? cardOf?.(terminalId) : null
      return card?.direct === true && simpleModeHelps(card.preset, store.state().active)
    }
  }
}

export function registerAccessIpc(ipc: Pick<IpcMain, 'handle'>, deps: AccessIpcDeps): void {
  const handlers = accessHandlers(deps)
  const [state, save, clear, simple, simpleOffer] = ACCESS_CHANNELS
  ipc.handle(state, () => handlers.state())
  ipc.handle(save, (_e, input: unknown) => handlers.save(input))
  ipc.handle(clear, () => handlers.clear())
  ipc.handle(simple, (_e, input: unknown) => handlers.simple(input))
  ipc.handle(simpleOffer, (_e, terminalId: unknown) => handlers.simpleOffer(terminalId))
}
