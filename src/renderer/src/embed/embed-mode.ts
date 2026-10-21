// EMBED MODE (strata): `?embed=agent&agent=<id>` boots the companion as ONE
// agent's terminal full view inside cookrew.dev's shell — the same
// TerminalOverlay and Dock the full view renders today, nothing of the canvas
// around them. Without `agent` it boots bare and waits for a strata:focus (a
// prewarm). It is only ever honoured inside a frame: opened as a page of its
// own, the companion is the classic one.

export interface EmbedMode {
  /** The agent to open at boot; null = a prewarm that waits for strata:focus. */
  agentId: string | null
}

const AGENT_ID = /^[A-Za-z0-9._:-]{1,200}$/

export const embedModeOf = (search: string, framed: boolean): EmbedMode | null => {
  if (!framed) return null
  const params = new URLSearchParams(search)
  if (params.get('embed') !== 'agent') return null
  const agent = params.get('agent')
  return { agentId: agent && AGENT_ID.test(agent) ? agent : null }
}

/** This document's embed mode, read once at boot. */
export const bootEmbedMode = (): EmbedMode | null => {
  let framed = false
  try {
    framed = window.parent !== window
  } catch {
    framed = true
  }
  return embedModeOf(window.location.search, framed)
}
