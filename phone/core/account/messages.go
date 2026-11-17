package account

import (
	"fmt"
	"regexp"
)

// PairContext opens the transcript a device signs to enter a machine with its
// account pass (src/shared/account-pair.ts · ACCOUNT_PAIR_CONTEXT).
const PairContext = "cookrew-pair/2"

// RenewPrefix opens the message a device signs to renew its account session
// (src/shared/session-renew.ts · RENEW_PREFIX).
const RenewPrefix = "cookrew-renew/1"

var (
	uuidShape      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	base64urlShape = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	// usernameShape is the registry's USERNAME (registry/src/v2-accounts.ts).
	usernameShape = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`)
)

// PairChallenge is what a machine's POST /api/pair/begin answers with.
type PairChallenge struct {
	ChallengeID string `json:"challengeId"`
	Nonce       string `json:"nonce"`
	DesktopID   string `json:"desktopId"`
	ExpiresAt   int64  `json:"expiresAt"`
}

// PairTranscript is the exact text a device signs for POST /api/pair.
//
// Every field is checked first: they are joined by spaces, so a field holding
// one could make two different challenges read as the same text. The caller
// must also check DesktopID is the machine it meant to enter, or a machine in
// the way could pass on another machine's challenge.
func PairTranscript(c PairChallenge, deviceID string) (string, error) {
	switch {
	case !uuidShape.MatchString(c.DesktopID):
		return "", fmt.Errorf("account: the challenge's desktop id %q is not a uuid", c.DesktopID)
	case !uuidShape.MatchString(c.ChallengeID):
		return "", fmt.Errorf("account: the challenge id %q is not a uuid", c.ChallengeID)
	case !base64urlShape.MatchString(c.Nonce):
		return "", fmt.Errorf("account: the challenge's nonce is not base64url")
	case !uuidShape.MatchString(deviceID):
		return "", fmt.Errorf("account: the device id %q is not a uuid", deviceID)
	}
	return PairContext + " " + c.DesktopID + " " + c.ChallengeID + " " + c.Nonce + " " + deviceID, nil
}

// RenewMessage is the exact text a device signs to renew its session.
func RenewMessage(username, deviceID, nonce string) (string, error) {
	switch {
	case !usernameShape.MatchString(username):
		return "", fmt.Errorf("account: %q is not a username", username)
	case !uuidShape.MatchString(deviceID):
		return "", fmt.Errorf("account: the device id %q is not a uuid", deviceID)
	case !base64urlShape.MatchString(nonce):
		return "", fmt.Errorf("account: the renewal nonce is not base64url")
	}
	return RenewPrefix + " " + username + " " + deviceID + " " + nonce, nil
}
