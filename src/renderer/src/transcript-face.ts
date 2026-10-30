import { createContext } from 'react'

/**
 * THE AGENT'S FACE BESIDE ITS SIDE OF THE CHAT (TranscriptRow.tsx).
 *
 * The transcript reads as a chat with the agent (the owner, 2026-10-31): your
 * prompts on the right, its tool calls and reply in a bubble on the left with
 * its face. The rows are memoised and know nothing of the card they belong
 * to, so the face comes down from the terminal that owns them.
 */
export const TranscriptFaceContext = createContext<React.ReactNode>(null)
