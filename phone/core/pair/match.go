package pair

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"

	"github.com/cookrew/cookrew-app/phone/core/account"
)

// MatchCode is a phone's key in six digits (owner 2026-11-17, security
// review): the Mac's "A phone joined: <name>. Keep it?" shows it beside a name
// the joiner chose, and the phone shows its own, so the owner keeps the phone
// in their hand and not a stranger's who spent a leaked QR first. The twin of
// registry/src/v2-phone-match.ts · phoneMatchCode: the first four bytes of
// SHA-256 over the key's RFC 7638 thumbprint text, big-endian, modulo a
// million.
func MatchCode(jwk account.JWK) (string, error) {
	thumbprint, err := account.Thumbprint(jwk)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(thumbprint))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(sum[:4])%1_000_000), nil
}

// JoinProofMessage is what a phone signs to join with a phone's code: proof it
// holds the key it names (registry/src/v2-phone-match.ts · phoneJoinMessage).
func JoinProofMessage(code, deviceID string) string {
	return "cookrew-join/1 " + code + " " + strings.ToLower(deviceID)
}

// Match is this phone's match number.
func (d Device) Match() (string, error) {
	jwk, err := d.Key.JWK()
	if err != nil {
		return "", err
	}
	return MatchCode(jwk)
}
