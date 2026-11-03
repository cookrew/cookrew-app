import { cookrew } from '../api'

/**
 * A prompt into an agent's own terminal: the words, then Enter on its own —
 * the two writes the voice bar and the card's reply box have always made, so
 * the reply shows in CHAT, LOG and LIVE alike. An empty prompt is a bare
 * Enter: it submits whatever was typed in the terminal itself.
 */
export function sendToAgent(agentId: string, text: string): void {
  const words = text.trim()
  if (words) cookrew().ptyInput(agentId, words)
  cookrew().ptyInput(agentId, '\r')
}
