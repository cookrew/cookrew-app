// @magpie-community/agent-cookrew — Cookrew as a row on Magpie's Agents page.
//
// Magpie runs this in moejs: no Node APIs, no fetch, no timers, no imports.
// It can only describe the row and say which keys to write into Cookrew's own
// file when the user picks a model there. Cookrew (src/main/route/gateway.ts)
// watches that file: `route.gateway` present = routed, keys gone = direct.
// Every card's env, the route read-back and the human hand-off stay in
// Cookrew; the plugin is only the step where the user connects the two.

export const agent = {
  id: 'cookrew',
  name: 'Cookrew',
  icon: 'https://cookrew.dev/favicon.svg',
  dir: '~/.cookrew',
  config: '~/.cookrew/magpie.json',
  format: 'json',
  model: 'route.model',
  ua: ['cookrew'],
  notice: 'New cards pick this up at once; running cards keep their route until re-spawned.'
}

export function connect({ gateway, model }) {
  return {
    'route.gateway': gateway.url,
    'route.v1': gateway.v1,
    'route.key': gateway.key,
    'route.model': model.id
  }
}
