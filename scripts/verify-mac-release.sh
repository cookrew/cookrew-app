#!/usr/bin/env bash
# Would macOS open this download? Run it before a release goes out.
#
#   scripts/verify-mac-release.sh release/mac-arm64/Cookrew.app
#   scripts/verify-mac-release.sh release/Cookrew-0.4.0-arm64.dmg
#
# Never launches the app. Exit 0 ready to ship, 1 not, 2 bad argument.
#
# Three checks, all run even after one fails, so one pass shows the whole
# problem:
#
#   codesign --verify --deep --strict   the signature holds over every file
#   spctl --assess                      Gatekeeper accepts it as notarized
#   xcrun stapler validate              the ticket is stapled, so a first
#                                       launch works with no network
#
# spctl's exit code is not enough. A Mac with assessments switched off answers
# "accepted, override=security disabled" for anything, so a pass has to name the
# notarized source.
#
# A dmg is mounted read-only and the app INSIDE it is what gets checked, because
# that is what Gatekeeper judges on first launch. The image itself stays
# unsigned: electron-builder notarizes and staples the app before it builds the
# dmg and the zip, so both carry the ticket with the app.

set -u

failed=0
mount_point=""

usage() {
  echo "usage: verify-mac-release.sh <Cookrew.app | Cookrew.dmg>" >&2
  exit 2
}

pass() {
  echo "  PASS  $1"
}

fail() {
  echo "  FAIL  $1"
  # --verbose prints a line per nested binary; the reason is at the end.
  [ -z "${2:-}" ] || printf '%s\n' "$2" | tail -n 4 | sed 's/^/        /'
  failed=1
}

check_signature() {
  local output
  if output=$(codesign --verify --deep --strict --verbose=2 "$1" 2>&1); then
    pass "codesign: signature is valid"
  else
    fail "codesign: signature does not verify" "$output"
  fi
}

check_gatekeeper() {
  local output status
  output=$(spctl --assess --type execute --verbose=4 "$1" 2>&1)
  status=$?
  if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -q 'source=Notarized Developer ID'; then
    pass "spctl: Gatekeeper accepts it as notarized"
  else
    fail "spctl: Gatekeeper would not accept it as notarized" "$output"
  fi
}

check_ticket() {
  local output
  if output=$(xcrun stapler validate "$1" 2>&1); then
    pass "stapler: ticket is stapled"
  else
    fail "stapler: no valid ticket" "$output"
  fi
}

verify_app() {
  echo "$1"
  check_signature "$1"
  check_gatekeeper "$1"
  check_ticket "$1"
}

detach_image() {
  [ -n "$mount_point" ] || return 0
  if hdiutil detach "$mount_point" -quiet 2>/dev/null || hdiutil detach "$mount_point" -force -quiet 2>/dev/null; then
    rmdir "$mount_point" 2>/dev/null
  else
    fail "hdiutil: could not detach $mount_point"
  fi
  mount_point=""
}

verify_dmg() {
  local temp_root app found=0
  temp_root=${TMPDIR:-/tmp}
  mount_point=$(mktemp -d "${temp_root%/}/verify-mac-release.XXXXXX") || {
    mount_point=""
    fail "could not make a mount point"
    return
  }
  trap detach_image EXIT
  trap 'exit 1' INT TERM

  if ! hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$1" >/dev/null; then
    rmdir "$mount_point" 2>/dev/null
    mount_point=""
    fail "hdiutil: could not mount $1"
    return
  fi

  for app in "$mount_point"/*.app; do
    [ -d "$app" ] || continue
    found=1
    verify_app "$app"
  done
  [ "$found" -eq 1 ] || fail "no .app inside $1"
  detach_image
}

[ "$#" -eq 1 ] || usage
target=${1%/}
if [ ! -e "$target" ]; then
  echo "verify-mac-release: no such file: $target" >&2
  exit 2
fi

case "$target" in
  *.app) verify_app "$target" ;;
  *.dmg) verify_dmg "$target" ;;
  *) usage ;;
esac

if [ "$failed" -ne 0 ]; then
  echo "NOT READY: macOS would stop this download."
  exit 1
fi
echo "READY: signed, notarized and stapled."
