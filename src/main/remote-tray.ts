import { Menu, Tray, nativeImage } from 'electron'
import { hostWords, type HostWords, type RemoteHostView } from '../shared/remote-access'

/**
 * THE MENU BAR, WHILE SOMEONE IS ON THIS MAC, OR REMOTE CONTROL IS ON.
 *
 * The banner lives in Cookrew's window, and someone at the Mac may be looking
 * at anything else. This is there whichever app is in front, and Stop works from
 * it. The switch outlives a restart, so nobody may remember turning it on. Nothing else is decided
 * here: the words are hostWords and Stop is the desk's.
 */
export interface RemoteTray {
  show(view: RemoteHostView): void
  dispose(): void
}

const SWITCH_ONLY: HostWords = { line: 'Remote control is on', short: 'Remote', rows: ['Remote control is on'], awake: null }

export function createRemoteTray(onStop: () => void, platform: string): RemoteTray {
  let tray: Tray | null = null
  const hide = (): void => {
    tray?.destroy()
    tray = null
  }
  return {
    show(view) {
      const words = hostWords(view, platform) ?? (view.switchOn ? SWITCH_ONLY : null)
      // A title is all a menu bar item needs on a Mac; a Linux tray has nowhere to put one.
      if (!words || platform !== 'darwin') return hide()
      tray ??= new Tray(nativeImage.createEmpty())
      tray.setTitle(`● ${words.short}`)
      tray.setToolTip(words.line)
      tray.setContextMenu(
        Menu.buildFromTemplate([
          ...words.rows.map((label) => ({ label, enabled: false })),
          ...(words.awake ? [{ label: words.awake, enabled: false }] : []),
          { type: 'separator' as const },
          { label: 'Stop', click: onStop }
        ])
      )
    },
    dispose: hide
  }
}
