import type { TranscriptLook } from './transcript-look'

/** Record views read CHAT/LOG from the transcript; only LIVE needs a PTY. */
export const shouldAttachTerminal = (look: TranscriptLook): boolean => look === 'live'
