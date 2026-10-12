// @magpie-community/agent-cookrew-sous — Cookrew's Sous as a row on Magpie's
// Agents page (design §12 J4).
//
// Magpie runs this in moejs: no Node APIs, no fetch, no timers, no imports.
// It can only describe the row and say which keys to write into Sous's own
// file when the user picks a model there. Cookrew (src/main/sous-config.ts ·
// sousRouteConfig) reads that file per call: `route.key` present = Sous
// speaks to the gateway under its own key and budget; file absent = nothing
// changes. The Cookrew row (resources/magpie) is the cards' route; this row
// is Sous's, so the two can be budgeted and limited apart.

export const agent = {
  id: 'sous',
  name: 'Cookrew Sous',
  icon: 'https://cookrew.dev/favicon.svg',
  dir: '~/.cookrew',
  config: '~/.cookrew/sous-magpie.json',
  format: 'json',
  model: 'route.model',
  ua: ['cookrew-sous'],
  notice: 'Sous decides with this model from its next sentence on; the cards keep their own route.'
}

export function connect({ gateway, model }) {
  return {
    'route.gateway': gateway.url,
    'route.v1': gateway.v1,
    'route.key': gateway.key,
    'route.model': model.id
  }
}
