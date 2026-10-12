#!/bin/sh
# Mint the scoped Magpie gateway key Sous speaks with (HP round, audit §11).
#
# `magpie gateway-key add` prints the new credential once; it goes straight
# into ~/.cookrew/sous-gateway.key (0600) and is never echoed. The key is
# then limited to the groups Sous may route to. Re-running rotates: the old
# key is removed by name first. Requires Magpie's "Share on local network".
set -eu
NAME="${COOKREW_SOUS_KEY_NAME:-Cookrew Sous}"
GROUPS_ALLOWED="${COOKREW_SOUS_KEY_MODELS:-group/jevs group/auto}"
BASE="${COOKREW_HOME:-$HOME/.cookrew}"
FILE="$BASE/sous-gateway.key"
umask 077
mkdir -p "$BASE"
# A previous key of this name is revoked before a new one is minted.
for ID in $(magpie gateway-key list | awk -v n="$NAME" 'index($0, n) { print $1 }'); do
  magpie gateway-key remove "$ID" >/dev/null 2>&1 || true
done
# The credential is printed once: capture it, write it, never show it.
magpie gateway-key add "$NAME" | tr -d '\r' | awk 'NF { line = $NF } END { print line }' > "$FILE.tmp"
if [ ! -s "$FILE.tmp" ]; then rm -f "$FILE.tmp"; echo "magpie-sous-key: no credential returned" >&2; exit 1; fi
chmod 600 "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
ID="$(magpie gateway-key list | awk -v n="$NAME" 'index($0, n) { print $1; exit }')"
if [ -z "$ID" ]; then echo "magpie-sous-key: key minted but its id was not found in 'gateway-key list'" >&2; exit 1; fi
# shellcheck disable=SC2086
magpie gateway-key models "$ID" $GROUPS_ALLOWED >/dev/null
echo "magpie-sous-key: stored a key for '$NAME' (id $ID) at $FILE, limited to: $GROUPS_ALLOWED"
