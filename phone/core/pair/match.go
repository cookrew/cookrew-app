package pair

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"github.com/cookrew/cookrew-app/phone/core/account"
)

// MatchCode is a phone's key and its join's salt in six digits (owner
// 2026-11-17, security review): the Mac's "A phone joined: <name>. Keep it?"
// shows it beside a name the joiner chose, and the phone shows its own, so the
// owner keeps the phone in their hand and not a stranger's who spent a leaked
// QR first. The salt is drawn by the registry after the key is fixed, so no
// key can be ground to match. The twin of registry/src/v2-phone-match.ts ·
// phoneMatchCode: the first four bytes of SHA-256 over
// "cookrew-match/2 <salt> <thumbprint>", big-endian, modulo a million.
func MatchCode(jwk account.JWK, salt string) (string, error) {
	if salt == "" {
		return "", errNoSalt
	}
	thumbprint, err := account.Thumbprint(jwk)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte("cookrew-match/2 " + salt + " " + thumbprint))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(sum[:4])%1_000_000), nil
}

// errNoSalt is a join that drew no match number: not a phone's code, or a registry older than the question.
var errNoSalt = errors.New("pair: this join has no match number")

// JoinProofMessage is what a phone signs to join with a phone's code: proof it
// holds the key it names (registry/src/v2-phone-match.ts · phoneJoinMessage).
func JoinProofMessage(code, deviceID string) string {
	return "cookrew-join/1 " + code + " " + strings.ToLower(deviceID)
}

// Match is the number this phone shows while its Mac is asked to keep it:
// its key with the salt its last join was given. Computed here, never taken
// from the answer, so it is this key's whatever was sent.
func (s State) Match() (string, error) {
	device, err := s.Device()
	if err != nil {
		return "", err
	}
	jwk, err := device.Key.JWK()
	if err != nil {
		return "", err
	}
	return MatchCode(jwk, s.Session.MatchSalt)
}
