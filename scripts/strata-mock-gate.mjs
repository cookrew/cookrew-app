// The strata preview mock's failure switches, as one pure decision per request
// so the lanes can drive their error paths on purpose: a pairing-token check,
// the relay's 503 too_many_exchanges storm, and a machine that never answers.
// Preview only: in production these refusals come from the relay and the desktop.

export const MOCK_SWITCHES = Object.freeze({ auth: false, storm: Object.freeze([]), hang: Object.freeze([]) })

/** The pairing token a mock machine accepts while auth is on, in the shape of a real one. */
export const mockToken = (machineId) => `mock-pairing-token-${machineId}`

const idsOf = (value, key) => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new Error(`${key} must be a list of machine ids`)
  }
  return Object.freeze([...new Set(value)])
}

/** The switches after a POST /mock/switch body; anything unknown or malformed is refused whole. */
export const nextSwitches = (current, body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('send a JSON object')
  const unknown = Object.keys(body).filter((key) => !(key in MOCK_SWITCHES))
  if (unknown.length > 0) throw new Error(`unknown switch: ${unknown.join(', ')}`)
  if ('auth' in body && typeof body.auth !== 'boolean') throw new Error('auth must be true or false')
  return Object.freeze({
    auth: 'auth' in body ? body.auth : current.auth,
    storm: 'storm' in body ? idsOf(body.storm, 'storm') : current.storm,
    hang: 'hang' in body ? idsOf(body.hang, 'hang') : current.hang
  })
}

/** The pairing token a request carries: Authorization: Bearer, or ?token= (EventSource sends no headers). */
export const tokenOf = (headers, url) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')
  return bearer ? bearer[1] : url.searchParams.get('token')
}

const RELAY_STORM = Object.freeze({
  status: 503,
  body: Object.freeze({ error: 'too_many_exchanges', message: 'That Mac is already carrying 16 requests through the relay. Try again in a moment.' })
})
const UNPAIRED = Object.freeze({ status: 401, body: Object.freeze({ error: 'unauthorized', message: 'This browser is not paired with that machine.' }) })

/**
 * What the mock does with one request under /m/<id>/: 'hang' (hold it and answer
 * nothing), a refusal shaped like the relay's or the desktop's, or null (serve it).
 * The order follows the wire: the relay refuses before the desktop reads a token.
 */
export const gate = (switches, { machineId, api, token }) => {
  if (switches.hang.includes(machineId)) return 'hang'
  if (switches.storm.includes(machineId)) return RELAY_STORM
  if (api && switches.auth && token !== mockToken(machineId)) return UNPAIRED
  return null
}
