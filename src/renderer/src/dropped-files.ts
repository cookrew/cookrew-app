import type { ImageSaver } from './clipboard-image'

/**
 * Dropped files, as paths an agent can read. Shared by the terminal's drop
 * and the prompt boxes' (prompt/use-prompt-attach.ts).
 *
 * A file stays where it lies — unless the system takes it away once the drag
 * is over. A screenshot dragged from its floating thumbnail is handed over in
 * TemporaryItems (NSIRD_screencaptureui_…) and deleted right after the drop
 * (owner, 2026-11-01: the path that reached the agent was already gone), so
 * its bytes are read at the drop and kept in the attach store. So is a file
 * with no path at all.
 */

export interface FileAttacher extends ImageSaver {
  attachFiles: (files: File[]) => Promise<string[]>
}

type DroppedFile = { name: string; type: string; arrayBuffer: () => Promise<ArrayBuffer> }

/** A path the system deletes once the drag that handed it over is done. */
export const isTemporaryDrop = (filePath: string): boolean => filePath.includes('/TemporaryItems/')

export async function pathsForFiles(files: readonly DroppedFile[], api: FileAttacher): Promise<string[]> {
  // On the desktop the paths come back within a microtask, before the drag
  // can end and take a temporary file away.
  const found = await api.attachFiles(files as File[])
  return Promise.all(
    files.map(async (file, i) => {
      const at = found[i]
      if (at && !isTemporaryDrop(at)) return at
      return api.saveAttachmentBytes(file.name || 'file', new Uint8Array(await file.arrayBuffer()))
    })
  )
}
