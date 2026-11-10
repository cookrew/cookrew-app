// FIRST, before anything else on the page is evaluated: this is what makes the
// page the console (console/console-wiring.ts). Every module after it that
// asks which kind of page it is on gets that answer.
import { consoleParts } from './console/console-wiring'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
import './night.css'
import './zoom/ink-theme.css'
import './zoom/root-theme.css'
import './phone-type.css'
import { applyColorScheme, applyTheme, storedTheme } from './color-scheme'
import { ConsoleShell } from './console/ConsoleShell'
import './console/console.css'
import { registerConsoleWorker } from './console/register-worker'
import { browserVersionWatch } from './console/console-version'
import { NewerBuild } from './console/NewerBuild'

/**
 * console.cookrew.dev: one static page for every machine of the account
 * (0.6.0). It boots to the account's machines and nothing more; a machine,
 * which is the whole app, is a chunk loaded when one is about to be opened.
 */

// Light or dark before the first paint: a browser follows the system.
applyColorScheme(true)
applyTheme(storedTheme())
document.body.classList.add('cr-ink')

const root = ReactDOM.createRoot(document.getElementById('root')!)

if (consoleParts === null) {
  // Built without the hosts it talks to: it asks nobody anything.
  root.render(<p className="cd-page">This page was not built to reach Cookrew. Open console.cookrew.dev.</p>)
} else {
  // One watch for the page: whether the host serves a newer build than this one.
  const version = browserVersionWatch()
  root.render(
    <React.StrictMode>
      <ConsoleShell parts={consoleParts} />
      <NewerBuild watch={version} />
    </React.StrictMode>
  )
  void consoleParts.runtime.boot()
  registerConsoleWorker()
}
