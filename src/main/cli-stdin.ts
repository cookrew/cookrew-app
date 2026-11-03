// `cookrew ask "Agent" -` / `cookrew recruit --prompt -`: the CLIENT reads the
// brief from stdin and sends the text (cli/cookrew.mjs). A lone dash that
// reaches the app means a client too old to know the form, and delivering it
// would hand the agent a "-" as its brief with no error. Refuse instead.
import type { CliRequest } from '../shared/model'

const HEREDOC_HINT =
  "this cookrew client did not read it. Update the CLI (npm run install-cli) or restart the app, then pipe the brief with a quoted heredoc: <<'EOF' … EOF"

export function stdinPlaceholderError(request: CliRequest): string | null {
  if (request.cmd === 'ask' && request.args[1] === '-' && request.flags.raw === undefined) {
    return `A lone - means "read the brief from stdin", and ${HEREDOC_HINT}`
  }
  if (request.cmd === 'recruit' && request.flags.prompt === '-') {
    return `--prompt - means "read the prompt from stdin", and ${HEREDOC_HINT}`
  }
  return null
}
