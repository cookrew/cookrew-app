// How this macOS build gets signed, decided from which secrets EXIST.
//
// release.yml hands this step `HAS_<SECRET>=true|false` and never a value, then
// branches on the answers. Decided here rather than in workflow expressions so
// the signed path, the one a repo without a certificate can never rehearse, is
// covered by tests/mac-signing-plan.test.ts.
//
//   nothing set        unsigned, job stays green, loud warning
//   certificate only   signed, loud warning: Gatekeeper still refuses it
//   certificate + one  signed and notarized
//   complete
//   login
//   half of any set    job FAILS and names what is missing. Falling back to
//                      unsigned here would ship the build the owner just paid
//                      to stop shipping, on the day they thought it was fixed.
//   a pull request     unsigned, whatever is set, which agrees with
//                      electron-builder. A fork's PR gets no secrets at all; a
//                      same-repo branch could edit the workflow to read them,
//                      and only an environment restricted to tags stops that.
//
// Writes mode, sign and notarize to GITHUB_OUTPUT and the story to
// GITHUB_STEP_SUMMARY. With neither set it prints to stdout, for a dry look.

import { appendFileSync } from 'node:fs'

const CERTIFICATE = ['CSC_LINK', 'CSC_KEY_PASSWORD']
const API_KEY = ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

const SECRETS_TABLE = `
| Secret | What it holds |
| --- | --- |
| \`CSC_LINK\` | Base64 of the **Developer ID Application** certificate exported as .p12 (\`base64 -i cert.p12\`) |
| \`CSC_KEY_PASSWORD\` | The password of that .p12 |

And one of these two sets, to notarize.

| App Store Connect API key (preferred) | |
| --- | --- |
| \`APPLE_API_KEY_P8\` | The full text of the \`AuthKey_XXXXXXXXXX.p8\` file |
| \`APPLE_API_KEY_ID\` | Its key ID |
| \`APPLE_API_ISSUER\` | Its issuer ID |

| Apple ID | |
| --- | --- |
| \`APPLE_ID\` | The account's email |
| \`APPLE_APP_SPECIFIC_PASSWORD\` | An app-specific password from account.apple.com |
| \`APPLE_TEAM_ID\` | The ten-character Team ID |
`

const isSet = (env, name) => env[`HAS_${name}`] === 'true'
const anySet = (env, names) => names.some((name) => isSet(env, name))
const allSet = (env, names) => names.every((name) => isSet(env, name))
const unset = (env, names) => names.filter((name) => !isSet(env, name))

function plan(env) {
  const unsigned = { mode: 'unsigned', sign: false, notarize: 'none' }
  if (env.GITHUB_EVENT_NAME === 'pull_request') return { ...unsigned, reason: 'pull-request' }

  const anyLogin = anySet(env, API_KEY) || anySet(env, APPLE_ID)
  if (!anySet(env, CERTIFICATE) && !anyLogin) return { ...unsigned, reason: 'no-secrets' }
  if (!allSet(env, CERTIFICATE)) return { missing: unset(env, CERTIFICATE) }

  if (allSet(env, API_KEY)) return { mode: 'notarized', sign: true, notarize: 'api-key' }
  if (allSet(env, APPLE_ID)) return { mode: 'notarized', sign: true, notarize: 'apple-id' }
  if (anyLogin) {
    const sets = [API_KEY, APPLE_ID].filter((set) => anySet(env, set))
    return { missing: sets.flatMap((set) => unset(env, set)) }
  }
  return { mode: 'signed', sign: true, notarize: 'none' }
}

function story(result) {
  if (result.missing) {
    const names = result.missing.join(', ')
    return {
      annotation: `::error title=macOS signing is half configured::Missing secret(s): ${names}`,
      summary: `## ❌ macOS signing is half configured\n\nMissing: **${names}**. Add them, or remove the rest to build unsigned.\n${SECRETS_TABLE}`
    }
  }
  if (result.mode === 'notarized') {
    return {
      summary: `## ✅ macOS build is signed and notarized\n\nNotarizing with: \`${result.notarize}\`. The verify step below is what proves it.\n`
    }
  }
  if (result.mode === 'signed') {
    return {
      annotation: '::warning title=macOS build is NOT notarized::Signed, but Gatekeeper still refuses an app that was never notarized.',
      summary: `## ⚠️ macOS build is signed but NOT notarized\n\nGatekeeper still refuses this download. Add one notarization login.\n${SECRETS_TABLE}`
    }
  }
  if (result.reason === 'pull-request') {
    return { summary: '## macOS build is unsigned\n\nThis is a pull request, and pull request builds are not signed.\n' }
  }
  return {
    annotation: '::warning title=macOS build is NOT signed::Gatekeeper will stop this download. See the job summary for the secrets to add.',
    summary: `## ⚠️ macOS build is NOT signed or notarized\n\n**Gatekeeper will stop this download**, so do not publish it as the release people get. To sign it, add these repository secrets.\n${SECRETS_TABLE}`
  }
}

function writeLines(file, text) {
  if (file) appendFileSync(file, text)
  else process.stdout.write(text)
}

const result = plan(process.env)
const { annotation, summary } = story(result)

if (annotation) console.log(annotation)
writeLines(process.env.GITHUB_STEP_SUMMARY, summary)
if (result.missing) process.exit(1)
writeLines(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nsign=${result.sign}\nnotarize=${result.notarize}\n`)
