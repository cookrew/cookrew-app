/**
 * SEALED TO ONE DEVICE, as the registry sees it.
 *
 * The construction moved to src/shared/device-seal.ts when the Mac became a
 * sealer too (V3-12): the desktop seals the pairing URL to the asking device
 * and this registry only relays the ciphertext and checks its shape. One
 * cipher, three readers — see that file for why it may not be copied.
 *
 * Re-exported under the old names so the routes and the tests that already
 * name them keep working.
 */
export {
  ed25519PublicToX25519,
  ed25519SeedToX25519,
  isSealedToDevice,
  openAtDevice,
  sealToDevice,
  type SealedToDevice
} from '../../src/shared/device-seal'
