// WHEN LINUX REFUSES THE SANDBOX (round 2, bug 13).
//
// Electron checks its sandbox in C++, before one line of the app runs, and aborts
// when it has neither kind: unprivileged user namespaces (off by default on Ubuntu
// 24.04 and later, under AppArmor) or a chrome-sandbox owned by root with mode 4755
// (impossible inside an AppImage: its mount is nosuid). No JS means no window, and
// the reason goes to a terminal that a double click never opened.
//
// So the packaged binary goes behind this sh script. A healthy system pays one
// fork and becomes the binary with `exec`. Only where neither sandbox looks
// usable does it stay around to watch, and it speaks only if the binary then
// really dies within seconds: the probe is a guess at Chromium's own check, and a
// false alarm over a running app would be worse than the silence. It never turns
// the sandbox off for anyone.
//
// electron-builder's AppImage desktop entry runs `AppRun --no-sandbox`, so this
// matters for the AppImage started as a file, which is how one is usually started.

const { chmodSync, renameSync, writeFileSync } = require('node:fs')
const path = require('node:path')

/** A start that dies later than this was not refused at the door. */
const ABORT_WINDOW_SECONDS = 20

/** `procSys` is /proc/sys, for a test to stand in for. */
function launchScript(binary, procSys = '/proc/sys') {
  return `#!/bin/sh
# Generated at packaging by scripts/linux-launch.cjs, which says why.
here=$(dirname "$(readlink -f "$0")")
bin="$here/${binary}"
helper="$here/chrome-sandbox"

# The app's own Node (the cookrew shim), and a sandbox turned off on purpose.
[ -z "$ELECTRON_RUN_AS_NODE" ] || exec "$bin" "$@"
for arg in "$@"; do
  [ "$arg" != --no-sandbox ] || exec "$bin" "$@"
done

# Written again below if this start fails too.
rm -f "$HOME/.cookrew/launch-failed.txt"

# AppArmor's restriction can let unshare through and still stop Chromium.
namespaces_ready() {
  [ "$(cat "${procSys}/kernel/apparmor_restrict_unprivileged_userns" 2>/dev/null)" != 1 ] && unshare -Ur true >/dev/null 2>&1
}

helper_ready() {
  set -- $(ls -ln "$helper" 2>/dev/null)
  [ "$3" = 0 ] || return 1
  case "$1" in
    ???s?????[xt]*) return 0 ;;
  esac
  return 1
}

if namespaces_ready || helper_ready; then
  exec "$bin" "$@"
fi

started=$(date +%s)
"$bin" "$@"
status=$?
# Chromium's own abort: SIGTRAP, or SIGILL or SIGABRT on some builds. Not a stop or a kill.
case "$status" in
  132 | 133 | 134) ;;
  *) exit "$status" ;;
esac
[ $(($(date +%s) - started)) -lt ${ABORT_WINDOW_SECONDS} ] || exit "$status"

if [ -z "$APPIMAGE" ]; then
  quoted=$(printf %s "$helper" | sed "s/'/'\\\\\\\\''/g")
  fix="To fix it, run: sudo chown root:root '$quoted' && sudo chmod 4755 '$quoted'"
elif [ "$(cat "${procSys}/kernel/apparmor_restrict_unprivileged_userns" 2>/dev/null)" = 1 ]; then
  fix="To fix it until the next restart, run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
elif [ "$(cat "${procSys}/kernel/unprivileged_userns_clone" 2>/dev/null)" = 0 ]; then
  fix="To fix it until the next restart, run: sudo sysctl -w kernel.unprivileged_userns_clone=1"
else
  fix="To fix it, allow unprivileged user namespaces on this system. An AppImage cannot use the other kind."
fi
why="Cookrew stopped before it could open a window: this system refused the sandbox it runs in.
$fix"

echo "$why" >&2
mkdir -p "$HOME/.cookrew" 2>/dev/null && echo "$why" > "$HOME/.cookrew/launch-failed.txt"
if [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
  # AppRun points this at the app's libraries, which a system tool must not load.
  unset LD_LIBRARY_PATH
  zenity --error --no-markup --title=Cookrew --text="$why" 2>/dev/null ||
    kdialog --title Cookrew --error "$why" 2>/dev/null ||
    xmessage -center "$why" 2>/dev/null ||
    notify-send Cookrew "$why" 2>/dev/null
fi
exit "$status"
`
}

/** Move the binary aside and put the script where AppRun and a person look for it. */
function wrapBinary(appOutDir, executable) {
  const script = path.join(appOutDir, executable)
  const binary = `${executable}.bin`
  renameSync(script, path.join(appOutDir, binary))
  writeFileSync(script, launchScript(binary))
  chmodSync(script, 0o755)
}

module.exports = { launchScript, wrapBinary }
