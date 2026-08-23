// The POST the author journey ends in.
//
// Written against registry/src/publish-routes.ts as it actually reads the
// body — {manifest, team, teamName} — rather than against a shape inferred
// from a commit message. The registry is in this tree now, so a guessed
// contract has no excuse; before the M2 merge this transport was deliberately
// an injected seam for exactly that reason.
//
// HTTPS ONLY, and the host comes from the recognised list rather than from
// anything the caller passes: a publish sends a signed manifest and the
// author's payout address, so the URL is assembled here from a host that was
// already trusted, never accepted whole from upstream. A default host would be
// a default recipient for that address.

import type { PresetManifest } from '../shared/preset-manifest'

/** Body limit the registry enforces; failing early beats a 413 round trip. */
const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024

export interface PushInput {
  manifest: PresetManifest
  teamBytes: Buffer
  host: string
  /** Bearer credential for the publish ceremony, when the deployment needs one. */
  token?: string
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Push a signed manifest to a recognised registry.
 *
 * Throws on anything but success, and the message carries the registry's own
 * status — publishPreset turns that into a `push`-step refusal, so an author
 * is told the registry said no rather than that their team was rejected.
 */
export async function pushToRegistry(input: PushInput): Promise<{ presetId: string }> {
  const team = input.teamBytes.toString('base64')
  const body = JSON.stringify({
    manifest: input.manifest,
    team,
    teamName: input.manifest.id
  })

  if (body.length > PUBLISH_BODY_LIMIT) {
    throw new Error(
      `This team is ${Math.round(body.length / 1024 / 1024)}MB, over the registry's ` +
        `${PUBLISH_BODY_LIMIT / 1024 / 1024}MB publish limit. Trim its attachments or history and retry.`
    )
  }

  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(`https://${input.host}/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.token !== undefined ? { authorization: `Bearer ${input.token}` } : {})
    },
    body
  })

  if (!response.ok) {
    // The registry's own words where it gave them. A publish that failed for a
    // reason the author can act on (an identity ceremony not completed, a
    // duplicate id) must not be flattened into "publish failed".
    let detail = ''
    try {
      const parsed = (await response.json()) as { error?: string }
      detail = typeof parsed.error === 'string' ? `: ${parsed.error}` : ''
    } catch {
      // A body we cannot parse adds nothing; the status still says plenty.
    }
    throw new Error(`registry refused (${response.status})${detail}`)
  }

  const parsed = (await response.json()) as { id?: string; presetId?: string }
  const presetId = parsed.presetId ?? parsed.id
  if (typeof presetId !== 'string' || presetId.length === 0) {
    // A 200 with no id is not a success we can hand back: the install URL we
    // would build from it would be wrong, and the author would share it.
    throw new Error('the registry accepted the publish but returned no preset id')
  }
  return { presetId }
}
