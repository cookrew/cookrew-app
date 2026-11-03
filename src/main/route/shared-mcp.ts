import type { HarnessId } from '../harness'

/**
 * ONE MCP HUB FOR THE WHOLE FLEET (route program, shared MCP).
 *
 * Measured 2026-11-01: 13 claude agents each started their own context7,
 * github and memory servers (an `npm exec` wrapper plus a node child each),
 * about 600 MB of copies, and 13 memory servers wrote one file. Magpie's
 * library router runs each server once and serves them all through one MCP
 * server per agent at `<gateway>/mcp/magpie/hub/<agent>`. Its tools are named
 * `<server>__<tool>`.
 *
 * Cookrew hands that hub to every agent it spawns, so a card has it whether or
 * not the owner's own harness config names it. The entry is called `magpie`,
 * the name magpie writes into the harness config itself, so where both exist
 * there is ONE entry (checked on the real binaries 2026-11-01):
 *
 *   claude 2.1: `--mcp-config` with a server of the same name as a user-scope
 *   one yields a single `magpie` server, connected. The flag is VARIADIC: it
 *   swallows any positional that follows, so these args must stay LAST on the
 *   command line, which is where the spawn appends them.
 *
 *   codex 0.166: `-c mcp_servers.magpie.url="…"` overrides the same key, and
 *   `codex mcp list` shows the one entry.
 *
 * opencode and pi get nothing per process: magpie writes the hub into their
 * own config files, and a per-process route for them is not proven.
 */

export const HUB_SERVER = 'magpie'

export function hubUrl(gatewayUrl: string, harness: HarnessId): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/mcp/magpie/hub/${harness}`
}

/** The args appended to a harness command so its process reaches the hub; [] where none are needed. */
export function sharedMcpArgs(harness: HarnessId, gatewayUrl: string): string[] {
  const url = hubUrl(gatewayUrl, harness)
  switch (harness) {
    case 'claude':
      return ['--mcp-config', JSON.stringify({ mcpServers: { [HUB_SERVER]: { type: 'http', url } } })]
    case 'codex':
      return ['-c', `mcp_servers.${HUB_SERVER}.url="${url}"`]
    default:
      return []
  }
}
