// The companion's two ports, in a module with no Electron import.
//
// mobile-server.ts pulls in `electron` (powerSaveBlocker), so anything that
// merely needs a port number cannot import it without dragging Electron into
// unit tests. mobile-server.ts re-exports these, so existing importers are
// unaffected.
//
// THEY ARE DEFAULTS, NOT FIXTURES. A second instance on one machine cannot
// bind a port the first already holds, so with these fixed no test instance
// could ever SERVE a door: the relay dialled it, the door had no local server
// behind it, and the importer was told "that team is live, but it didn't
// answer just now" — a sentence about the door's owner that was really about
// the harness. That is the same shape as the registry origin this file's
// neighbour used to pin (registry-origin.ts): a deployment value written as a
// literal is a deployment nobody can move.
//
// Read once, at load: main's environment is fixed when the process starts, and
// a port that changed underneath a listening server would be a worse bug than
// the one this solves.

/** A port from the environment, or the shipped default when it is not one. */
function portFrom(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const port = Number(raw)
  // A malformed override is a typo, and a typo must not silently move the
  // companion somewhere nobody is looking — it keeps the shipped port.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name}=${raw} is not a port — keeping ${fallback}`)
    return fallback
  }
  return port
}

export const MOBILE_PORT = portFrom('COOKREW_MOBILE_PORT', 8639)
export const MOBILE_HTTPS_PORT = portFrom('COOKREW_MOBILE_HTTPS_PORT', 8643)
