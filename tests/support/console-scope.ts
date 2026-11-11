/**
 * A CONSOLE PAGE, FOR A SUITE: the renderer under test reaches machines
 * through the relay, with one of them in scope.
 *
 * The renderer keeps "which machine" in machine-scope.ts, and most suites load
 * a fresh module graph per case (vi.resetModules), so this is called AFTER the
 * reset and before the modules under test are imported. It answers the
 * machine's relay address, which is what every relayed request then begins
 * with.
 */

export const API_ORIGIN = 'https://api.cookrew.dev'

/** A machine's address on the relay: `<api origin>/api/m/<machine id>`. */
export const relayBaseFor = (machineId: string, origin: string = API_ORIGIN): string => `${origin}/api/m/${machineId.toLowerCase()}`

/**
 * A request the page sent to the relay's ONE ADDRESS (latency 0.6.1), read
 * back as the path it names, the way the registry reads it
 * (shared/machine-relay.ts · relayPathFromHeaders). A suite that asks "which
 * machine, which route" keeps asking it of the path; anything else is the URL
 * it was.
 */
export const unfoldRelay = (url: string, init: RequestInit = {}): string => {
  const headers = new Headers(init.headers)
  const machine = headers.get('x-cookrew-machine')
  const route = headers.get('x-cookrew-route')
  if (!/\/api\/m$/.test(url) || machine === null || route === null) return url
  return `${url}/${machine}/${route.replace(/^\/+/, '')}`
}

export async function inConsole(
  machineId: string | null,
  options: { origin?: string; session?: () => string | null } = {}
): Promise<typeof import('../../src/renderer/src/machine-scope')> {
  const scope = await import('../../src/renderer/src/machine-scope')
  scope.configureMachineScope({ relay: { origin: options.origin ?? API_ORIGIN, session: options.session ?? (() => 'account-session') } })
  if (machineId !== null) scope.enterMachine(machineId)
  return scope
}
