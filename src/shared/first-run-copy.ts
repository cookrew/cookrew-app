/**
 * EVERY WORD A NEW PERSON READS IN THE FIRST RUN, in one place so one test can
 * hold them all to the same rule: no word of ours. A tool is named with what
 * it does for them, and a screen says what happens next, never how Cookrew is
 * built (tests/first-run-copy.test.ts).
 */

export const PREFLIGHT_COPY = {
  TITLE: 'Let’s check this Mac',
  LEDE: 'Cookrew runs AI agents that do real work in your folders. Here is what it found.',
  FOUND: 'Found',
  MISSING: 'Not found',
  UNKNOWN: 'Could not check',
  OPTIONAL: 'Optional',
  CHECK_AGAIN: 'Check again',
  CONTINUE: 'Continue',
  SKIP: 'Skip for now',
  NEEDS_ONE: 'Install Claude Code or Codex to start your first agent.',
  CHECKING: 'Checking…',
  SETUP_TITLE: 'Installing here. It may ask you a question.',
  RUNNING: 'Working…'
} as const

export const TOOL_COPY = {
  claude: { name: 'Claude Code', does: 'Runs your agent. You need this or Codex.' },
  codex: { name: 'Codex', does: 'Runs your agent. You need this or Claude Code.' },
  multiplexer: { name: 'herdr or tmux', does: 'Keeps your agents alive across restarts.' },
  chrome: { name: 'Chrome', does: 'Lets agents open and use web pages.' },
  magpie: { name: 'Magpie', does: 'Lets agents use other AI models.' },
  ollama: { name: 'Ollama', does: 'Gives agents short names, on this Mac.' }
} as const

export const TOOL_NOTES = {
  NOT_KEPT: 'Without it, your agents stop when you close Cookrew.',
  RESTART: 'Installed. Restart Cookrew to turn it on.',
  NOT_SIGNED_IN: 'Not signed in yet.'
} as const

export const FIX_LABELS = {
  INSTALL: 'Install',
  INSTALL_TMUX: 'Install tmux',
  HOMEBREW_FIRST: 'Install Homebrew first',
  GET: 'Download',
  SIGN_IN: 'Sign in'
} as const

export const FIRST_SCREEN_COPY = {
  ASK: 'What should your agent do?',
  LEDE: 'It works in one folder on this Mac, and you can watch every step.',
  FOLDER: 'Choose a folder',
  FOLDER_CHANGE: 'Change',
  FOLDER_NOTE: 'Folder',
  TRY: 'Try one of these, or type your own',
  FOLDER_FAILED: 'That folder could not be used. Try another one.'
} as const

/** Real work, safe in any folder: two read it, one writes one new file. */
export const EXAMPLE_TASKS = [
  'Explain what is in this folder',
  'Find broken or outdated files here',
  'Write a short README for this folder'
] as const

export const HINT_COPY = {
  PHONE_TITLE: 'Your agent finished its first task',
  PHONE_LEDE: 'Follow your agents from your phone, and answer them when they ask.',
  PHONE_GO: 'Show the QR code',
  NOT_NOW: 'Not now',
  SECOND_TITLE: 'You can run more than one agent',
  SECOND_LEDE: 'Press ✕ beside the name in the prompt box, or ＋ when it is folded, and give a new agent its own task. They work side by side.',
  SECOND_GO: 'Got it'
} as const
