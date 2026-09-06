// The canvas, told what to do by main. Three verbs and no more: everything a
// spoken sentence may do to the VIEW (as opposed to the store, which has its
// own ops) is one of these. Desktop gets them over IPC, the phone and the TV
// over the /api/events stream as `ui`, so every surface follows the same zoom.

export type UiCommand =
  | { kind: 'zoom'; nodeId: string }
  | { kind: 'zoom-back' }
  | { kind: 'focus-input'; nodeId: string }

/** What rides the stream: the command and the canvas it is for. */
export interface UiCommandEvent {
  workspaceId: string
  command: UiCommand
}
