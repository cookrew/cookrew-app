/**
 * THE PROMPT'S WORDS RUN AS THEY ARE (owner, 2026-11-09). The prompt box says
 * a #note as `cookrew note "Name"` and a #browser as `cookrew browser "Name"`
 * (renderer prompt/artifact-refs.ts), so an agent that runs those words as
 * they are reads the note, or learns the browser card's verbs with its name
 * already in them, instead of a bare usage line.
 */

const NOTE_VERBS: ReadonlySet<string> = new Set(['create', 'read', 'write', 'edit', 'delete'])

const BROWSER_VERBS: ReadonlySet<string> = new Set([
  'create',
  'snapshot',
  'click',
  'fill',
  'type',
  'key',
  'navigate',
  'screenshot',
  'evaluate',
  'html',
  'text',
  'info',
  'tap',
  'swipe',
  'scroll',
  'status',
  'tabs',
  'downloads',
  'tab-new',
  'tab-select',
  'tab-close'
])

/** `note "Name"` is `note read "Name"`; anything else stays as it was. */
export function bareNoteArgs(args: readonly string[]): readonly string[] {
  return args.length === 1 && !NOTE_VERBS.has(args[0]) ? ['read', args[0]] : args
}

/** `browser "Name"`: the verbs that drive the card, named; null when a verb leads. */
export function bareBrowserHint(args: readonly string[]): string | null {
  if (args.length !== 1 || BROWSER_VERBS.has(args[0])) return null
  const name = JSON.stringify(args[0])
  return [
    `A browser card is driven with a verb before its name:`,
    `  cookrew browser snapshot ${name}        what the page shows, with refs to click`,
    `  cookrew browser text|info|screenshot ${name}`,
    `  cookrew browser click|fill|type|key|navigate ${name} ...`,
    `  cookrew browser tabs|downloads ${name}`,
    `A screen card (screen://, adb://) takes screenshot, tap, swipe, type, key, scroll, status. Run 'cookrew help'.`
  ].join('\n')
}
