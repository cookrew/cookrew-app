// THE FUSES (owner 2026-11-05: only Cookrew may read a sealed secret).
//
// The keychain item that holds the secrets' key trusts this signed binary
// (src/main/secrets-seal.ts), so the wall is only as good as what the binary
// will agree to run. Fuses are read from the binary itself, flipped here between
// packing and signing, so the signature covers them.
//
//   NODE_OPTIONS, --inspect        off: each ran any JS inside the real app, where
//                                  safeStorage opens every value
//   only the asar, checked         on: the app's code cannot be swapped under the
//                                  same signature
//   RunAsNode                      ON, and it must stay on: the `cookrew` shim runs
//                                  on this binary (src/main/cli-shim.ts). Node mode
//                                  has no safeStorage, and the hardened runtime
//                                  refuses an unsigned native addon, so it gives a
//                                  script no way to the keychain item.
//
// Mac only: the shim's keychain promise is a Mac one, and a fuse that stops an
// unsigned Windows or Linux build from starting would buy nothing.

const fuseConfig = (options) => ({
  [options.RunAsNode]: true,
  [options.EnableNodeOptionsEnvironmentVariable]: false,
  [options.EnableNodeCliInspectArguments]: false,
  [options.EnableEmbeddedAsarIntegrityValidation]: true,
  [options.OnlyLoadAppFromAsar]: true
})

exports.fuseConfig = fuseConfig

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses')
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  await flipFuses(app, {
    version: FuseVersion.V1,
    // Flipping breaks the ad hoc seal an arm64 binary needs to start at all;
    // this redoes it, and a real identity signs over it after this hook.
    resetAdHocDarwinSignature: true,
    ...fuseConfig(FuseV1Options)
  })
}
