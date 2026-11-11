/**
 * WHERE GOING INTO ANOTHER MACHINE TAKES YOU, BY SURFACE (owner 2026-11-11:
 * every device on one canvas). On the desktop it opens in place, over this
 * machine's view (RemoteMachineView.tsx). On the console a machine is the whole
 * app, so the console puts that machine in scope instead, at the workspace
 * asked for (console/ConsoleMachine.tsx sets this). Null: open in place.
 */
export type MachineOpener = (machineId: string, workspaceId: string | null) => void

let opener: MachineOpener | null = null

export function setMachineOpener(next: MachineOpener | null): () => void {
  opener = next
  return () => {
    if (opener === next) opener = null
  }
}

export const machineOpener = (): MachineOpener | null => opener
