// The companion's two ports, in a module with no Electron import.
//
// mobile-server.ts pulls in `electron` (powerSaveBlocker), so anything that
// merely needs a port number cannot import it without dragging Electron into
// unit tests. mobile-server.ts re-exports these, so existing importers are
// unaffected.

export const MOBILE_PORT = 8639
export const MOBILE_HTTPS_PORT = 8643
