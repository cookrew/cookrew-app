// Package pair takes the native phone into a Cookrew account and every machine
// on it (owner 2026-11-16): a QR join code minted on a Mac under step-up, the
// account's phone pass, and each machine's own door. It is the Go twin of the
// watch's Join.swift and Enter.swift, for a trusted phone instead of a watch.
//
// The flow, and where each step lives on the other side:
//
//   - scan  → JoinCode            src/shared/join-code.ts · normaliseJoinCode
//   - join  → Registry.Join       registry/src/v2-join.ts · redeemJoinCode
//   - pass  → Registry.PhonePass  registry/src/v2-device-grant.ts · issuePhoneGrant
//   - Macs  → Registry.Desktops   registry/src/v2-routes.ts · GET /v2/me/desktops
//   - enter → Enter               src/main/account-pair.ts (begin, then finish)
//   - renew → Keeper              registry/src/v2-renew.ts
//
// Pure Go: it never imports the UI framework.
package pair

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// joinCodeShape is the registry's alphabet (no 0/O, no 1/I/L), two blocks of
// four with the dash optional (src/shared/join-code.ts · JOIN_CODE).
var joinCodeShape = regexp.MustCompile(`^([2-9A-HJ-NP-Z]{4})-?([2-9A-HJ-NP-Z]{4})$`)

// ErrNotACode is returned for anything a join code could not be read from.
var ErrNotACode = errors.New("pair: that is not a Cookrew join code")

// JoinCode reads a join code from what was scanned or typed: the QR's link
// (https://cookrew.dev/join#K7QM-2XPD) or the code itself, forgiving case,
// spaces and the dash. The link's host is never trusted for anything: the
// phone joins the registry it was built for, whatever a QR says.
func JoinCode(scanned string) (string, error) {
	raw := strings.TrimSpace(scanned)
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Fragment != "" {
		raw = u.Fragment
	}
	plain := strings.NewReplacer(" ", "", "\t", "", "·", "").Replace(strings.ToUpper(raw))
	match := joinCodeShape.FindStringSubmatch(plain)
	if match == nil {
		return "", ErrNotACode
	}
	return match[1] + "-" + match[2], nil
}
