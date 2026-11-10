/**
 * THE CONSOLE'S SERVICE WORKER (scripts/console-sw.mjs writes it at build):
 * the page's own static files from a cache, so a second visit paints without
 * the network, and nothing else. It never sees an API answer: those go to
 * another origin, which a worker of this origin's scope does not cache.
 *
 * Registered only by a built page. A new worker takes over the next time the
 * page is opened, never under a finger: this page does not reload itself.
 */
/** Set by the console's config (vite.console.config.ts), build or serve; absent in the app's own build and in tests. Served with no sw.js there is nothing to register, and that is caught. */
declare const __COOKREW_CONSOLE_BUILD__: boolean | undefined

export function registerConsoleWorker(nav: Navigator = navigator, built: boolean = typeof __COOKREW_CONSOLE_BUILD__ !== 'undefined'): void {
  if (!built || !('serviceWorker' in nav)) return
  window.addEventListener('load', () => {
    void nav.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
  })
}
