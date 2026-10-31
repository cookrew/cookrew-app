/**
 * THE RECORDED MOTION — the hero's promo and the zoom strip under FEATURES.
 *
 * Every clip is the running app in its ink theme, driven by real clicks over
 * the phone companion against the owner's own workspace (2026-10-31): real
 * agents, real cables, real replies, nothing written for the shot. A caption
 * says what was clicked and what answered, never what a feature is for — the
 * features grid already says that.
 */
export interface Motion {
  /** The file's stem under registry/assets/site/: `<file>.mp4` and its poster `<file>.jpg`. */
  file: string
  w: number
  h: number
  step: string
  title: string
  caption: string
}

export const PROMO = {
  label:
    'Twenty-three seconds of the running app: out to the machines, into one workspace whose ten agents are tied by ink cables, one agent\u2019s card, its whole transcript, and back out — one click each',
  caption:
    'Twenty-three seconds of the running app, recorded on 31 October 2026. A click on the empty paper steps out to the machines — this Mac, its seven workspaces on the screen; a click on it comes back in; a click on Cookrew Dev raises its ten agents tied by ink cables; one agent opens as a card, then as its whole transcript, and Esc and a click on the paper step back out. The agents are the owner\u2019s own and were working while it was filmed; nothing was written for the shot.'
}

export const MOTION: readonly Motion[] = [
  {
    file: 'motion-machines',
    w: 960,
    h: 600,
    step: 'OUT · IN',
    title: 'The machines',
    caption:
      'Clicked the empty paper: the view stepped out to the machines — this Mac as a laptop with its seven workspaces on the screen. Clicked the laptop: back in to the workspaces.'
  },
  {
    file: 'motion-crew',
    w: 960,
    h: 600,
    step: 'CREW',
    title: 'One workspace, its crew',
    caption:
      'Clicked Cookrew Dev: its ten agents rose out of the mark as ensō faces, the cables between them drawn as ink strokes, each one’s state — working, done, offline — under its name.'
  },
  {
    file: 'motion-card',
    w: 960,
    h: 600,
    step: 'CARD',
    title: 'One agent, its card',
    caption:
      'Clicked Fresco: its card opened where it stood — its state, its browser and note counts, the last thing it said, the pages it has open, and a box to reply in.'
  },
  {
    file: 'motion-full',
    w: 960,
    h: 600,
    step: 'FULL',
    title: 'The whole transcript',
    caption:
      'Clicked Fresco again: the card grew into its full view — the transcript set on a paper sheet, tool calls in mono, its checkpoints on the rail at the right.'
  },
  {
    file: 'motion-out',
    w: 960,
    h: 600,
    step: 'BACK',
    title: 'Out by a click',
    caption:
      'Pressed Esc, then clicked the paper: one stop out each time, back to the crew. The wheel never zooms — a click goes in, a click on the paper or Esc comes out.'
  },
  {
    file: 'motion-phone',
    w: 960,
    h: 600,
    step: 'PHONE',
    title: 'The same walk on a phone',
    caption:
      'The phone companion at 412 px against the same Mac: the crew, Fresco’s card, its transcript, and Esc back out — the same stops, by touch.'
  }
]
