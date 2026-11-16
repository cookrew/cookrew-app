package account

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// vectors is tests/fixtures/phone-contract/account-vectors.json, written by
// tests/phone-account-vectors.test.ts from the TypeScript functions themselves.
type vectors struct {
	Pair       PairChallenge `json:"pair"`
	RenewNonce string        `json:"renewNonce"`
	Keys       []struct {
		Seed           string `json:"seed"`
		JWK            JWK    `json:"jwk"`
		Thumbprint     string `json:"thumbprint"`
		DeviceID       string `json:"deviceId"`
		PairTranscript string `json:"pairTranscript"`
		PairSig        string `json:"pairSig"`
		RenewMessage   string `json:"renewMessage"`
		RenewSig       string `json:"renewSig"`
	} `json:"keys"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	path := filepath.Join("..", "..", "..", "tests", "fixtures", "phone-contract", "account-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the shared vectors (run the vitest suite first): %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decoding the shared vectors: %v", err)
	}
	if len(v.Keys) == 0 {
		t.Fatal("the shared vectors hold no keys")
	}
	return v
}

func TestMatchesTheTypeScriptDerivations(t *testing.T) {
	v := loadVectors(t)
	for _, want := range v.Keys {
		seed, err := hex.DecodeString(want.Seed)
		if err != nil {
			t.Fatalf("seed %q: %v", want.Seed, err)
		}
		key, err := FromSeed(seed)
		if err != nil {
			t.Fatalf("FromSeed: %v", err)
		}
		jwk := must(t, key.JWK)
		id := must(t, func() (string, error) { return DeviceID(jwk) })
		transcript := must(t, func() (string, error) { return PairTranscript(v.Pair, id) })
		renew := must(t, func() (string, error) { return RenewMessage("alice", id, v.RenewNonce) })
		checks := []struct{ name, got, want string }{
			{"jwk.x", jwk.X, want.JWK.X},
			{"jwk.kty", jwk.Kty, want.JWK.Kty},
			{"jwk.crv", jwk.Crv, want.JWK.Crv},
			{"thumbprint", must(t, func() (string, error) { return Thumbprint(jwk) }), want.Thumbprint},
			{"deviceId", id, want.DeviceID},
			{"pairTranscript", transcript, want.PairTranscript},
			{"pairSig", must(t, func() (string, error) { return key.Sign(transcript) }), want.PairSig},
			{"renewMessage", renew, want.RenewMessage},
			{"renewSig", must(t, func() (string, error) { return key.Sign(renew) }), want.RenewSig},
		}
		for _, c := range checks {
			if c.got != c.want {
				t.Errorf("seed %s… %s: got %q, TypeScript says %q", want.Seed[:8], c.name, c.got, c.want)
			}
		}
	}
}

func TestFromSeedRefusesAWrongLength(t *testing.T) {
	if _, err := FromSeed(make([]byte, 31)); err != ErrBadSeed {
		t.Fatalf("a 31-byte seed: got %v, want ErrBadSeed", err)
	}
}

func TestSeedIsACopy(t *testing.T) {
	key, err := NewKey()
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	first := key.Seed()
	first[0] ^= 0xff
	if key.Seed()[0] == first[0] {
		t.Fatal("changing a returned seed changed the key's own")
	}
}

func must[T any](t *testing.T, f func() (T, error)) T {
	t.Helper()
	v, err := f()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return v
}

func TestAnEmptyKeyRefusesInsteadOfPanicking(t *testing.T) {
	var empty Key
	if _, err := empty.Sign("x"); err != ErrNoKey {
		t.Errorf("Sign: %v", err)
	}
	if _, err := empty.JWK(); err != ErrNoKey {
		t.Errorf("JWK: %v", err)
	}
}

func TestOnlyAnOKPKeyNamesADevice(t *testing.T) {
	for _, j := range []JWK{{}, {Kty: "EC", Crv: "P-256", X: "abc"}, {Kty: "OKP", Crv: "X25519", X: "abc"}} {
		if _, err := DeviceID(j); err != ErrNotOKP {
			t.Errorf("DeviceID(%+v): %v", j, err)
		}
		if _, err := Thumbprint(j); err != ErrNotOKP {
			t.Errorf("Thumbprint(%+v): %v", j, err)
		}
	}
}

func TestATranscriptRefusesFieldsThatCouldShiftItsWords(t *testing.T) {
	good := PairChallenge{
		DesktopID:   "6c1f3a52-0e9b-4c7d-8a21-5f0d9e3b7c41",
		ChallengeID: "2f9d6e1a-4b3c-4d5e-9f60-718293a4b5c6",
		Nonce:       "bm9uY2Utb2YtdGhpcnR5LXR3by1ieXRlcy1sb25nLiE",
	}
	device := "ead074e4-96b9-8ed9-9e02-2ca7bbe51d5a"
	if _, err := PairTranscript(good, device); err != nil {
		t.Fatalf("a good challenge: %v", err)
	}
	bad := []PairChallenge{
		{DesktopID: good.DesktopID + " x", ChallengeID: good.ChallengeID, Nonce: good.Nonce},
		{DesktopID: good.DesktopID, ChallengeID: "not-a-uuid", Nonce: good.Nonce},
		{DesktopID: good.DesktopID, ChallengeID: good.ChallengeID, Nonce: "has space in it here"},
		{DesktopID: good.DesktopID, ChallengeID: good.ChallengeID, Nonce: "short"},
	}
	for _, c := range bad {
		if _, err := PairTranscript(c, device); err == nil {
			t.Errorf("PairTranscript(%+v) was accepted", c)
		}
	}
	if _, err := RenewMessage("Alice Smith", device, good.Nonce); err == nil {
		t.Error("a username with a space was accepted")
	}
}
