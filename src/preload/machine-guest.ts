import { contextBridge, ipcRenderer } from 'electron'
import { GUEST_COMMAND_CHANNEL, GUEST_REPORT_CHANNEL, parseGuestCommand, parseGuestReport, type GuestCommand } from '../shared/machine-guest'

/**
 * THE GUEST'S PRELOAD (shared/machine-guest.ts): another machine's app, in a
 * <webview> of this window, speaks to the window that holds it and to nobody
 * else. Two words and nothing of main: no `window.cookrew` here, so the page
 * boots as the console does (renderer api.ts · cookrew), and main set this
 * preload itself (main/index.ts · will-attach-webview).
 */
contextBridge.exposeInMainWorld('cookrewGuest', {
  report: (message: unknown): void => {
    const report = parseGuestReport(message)
    if (report) ipcRenderer.sendToHost(GUEST_REPORT_CHANNEL, report)
  },
  onCommand: (cb: (command: GuestCommand) => void): (() => void) => {
    const listener = (_event: unknown, value: unknown): void => {
      const command = parseGuestCommand(value)
      if (command) cb(command)
    }
    ipcRenderer.on(GUEST_COMMAND_CHANNEL, listener)
    return () => ipcRenderer.removeListener(GUEST_COMMAND_CHANNEL, listener)
  }
})
