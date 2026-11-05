/** A live pane no card reaches: its card is gone and its process is not. */
export interface StrayPane {
  session: string
  terminalId: string | null
  name: string | null
  cwd: string | null
  workspaceName: string | null
  /** This store spawned it, so it may be ended. Otherwise it is only shown. */
  proved: boolean
}
