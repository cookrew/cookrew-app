#!/usr/bin/env node
/**
 * A FRESH VAPID KEY PAIR for phone push (HITL phase 4), printed to stdout as
 * the environment lines the registry reads (registry/src/v2-push-vapid.ts):
 *
 *   node scripts/vapid-keys.mjs
 *
 * Nothing is written anywhere. The private key is a secret: put it in the
 * deployment's secret store, never in a file in this repository. Changing the
 * pair later unsubscribes every browser (each was bound to the old public key),
 * so it is made once and kept.
 */
import { generateKeyPairSync } from 'node:crypto'

// By way of a JWK: its members are always full length (32 bytes each), where ECDH's private key
// drops a leading zero byte once in 256 pairs.
const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
process.stdout.write(
  [
    `COOKREW_VAPID_PUBLIC_KEY=${point.toString('base64url')}`,
    `COOKREW_VAPID_PRIVATE_KEY=${jwk.d}`,
    'COOKREW_VAPID_SUBJECT=mailto:ops@cookrew.dev',
    ''
  ].join('\n')
)
