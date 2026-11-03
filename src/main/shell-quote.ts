/**
 * ONE SHELL QUOTE for every line Cookrew hands a POSIX shell: the boot
 * scripts of the tmux and herdr backends, the direct backend's `-c` command,
 * and the route's args on a harness command line. A plain token passes as
 * it is; anything else is single-quoted with the quote itself escaped the
 * POSIX way (`'\''`), which is the only escape a single-quoted string has.
 */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}
