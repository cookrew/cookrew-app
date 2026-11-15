import path from 'node:path'

/**
 * A POSIX-looking path literal as the host's own `path` writes it.
 *
 * The code under test builds paths with `path.join`, so on Windows
 * `/Users/me` + `.cookrew` comes back as `\Users\me\.cookrew`. Building the
 * expectation the same way keeps the assertion about WHICH path, not about the
 * separator. Identity on macOS and Linux.
 */
export const native = (posix: string): string => path.normalize(posix)

/**
 * Why a Seatbelt profile's text is not checked on Windows: Seatbelt is macOS's
 * sandbox, and on a Windows host the deny list holds Windows paths, which the
 * profile quotes with escaped backslashes no real profile ever contains. The
 * deny LIST itself is still checked there, through `native`.
 */
export const NO_SEATBELT_ON_WINDOWS = process.platform === 'win32'
