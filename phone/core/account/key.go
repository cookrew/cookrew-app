// Package account is the native phone's identity on a Cookrew account: an
// Ed25519 device key, the device id derived from it, and the messages it signs.
//
// Every derivation here has a TypeScript twin, pinned by the shared fixture
// tests/fixtures/phone-contract/account-vectors.json:
//
//   - DeviceID       src/main/account-v2.ts · deviceIdFor
//   - Thumbprint     src/shared/jwk-thumbprint.ts · jwkThumbprint
//   - PairTranscript src/shared/account-pair.ts · pairTranscript
//   - RenewMessage   src/shared/session-renew.ts · renewMessage
//
// The package is pure Go and never imports the UI framework.
package account

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// SeedSize is the length of an Ed25519 private seed, the only secret a device keeps.
const SeedSize = ed25519.SeedSize

// JWK is the public half of a device key as the registry and the Mac read it.
type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
}

// Key is a device's signing key. It is a value: nothing mutates it after New or FromSeed.
type Key struct {
	seed    []byte
	private ed25519.PrivateKey
}

var (
	// ErrBadSeed is returned for a seed that is not exactly SeedSize bytes.
	ErrBadSeed = errors.New("account: a device seed must be 32 bytes")
	// ErrNoKey is returned by a Key that was never made by NewKey or FromSeed.
	ErrNoKey = errors.New("account: the device key is empty")
	// ErrNotOKP is returned for a JWK that is not an Ed25519 OKP key.
	ErrNotOKP = errors.New("account: only an Ed25519 OKP key names a device")
)

// NewKey makes a fresh device key from the system's random source.
func NewKey() (Key, error) {
	seed := make([]byte, SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return Key{}, fmt.Errorf("account: reading random bytes for a device key: %w", err)
	}
	return FromSeed(seed)
}

// FromSeed rebuilds the key a seed names, as it was stored.
func FromSeed(seed []byte) (Key, error) {
	if len(seed) != SeedSize {
		return Key{}, ErrBadSeed
	}
	kept := append([]byte(nil), seed...)
	return Key{seed: kept, private: ed25519.NewKeyFromSeed(kept)}, nil
}

// Seed is a copy of the secret to store (sdk/secure on the phone).
func (k Key) Seed() []byte { return append([]byte(nil), k.seed...) }

// JWK is the public key as an OKP JSON Web Key.
func (k Key) JWK() (JWK, error) {
	if k.private == nil {
		return JWK{}, ErrNoKey
	}
	public := k.private.Public().(ed25519.PublicKey)
	return JWK{Kty: "OKP", Crv: "Ed25519", X: base64.RawURLEncoding.EncodeToString(public)}, nil
}

// Sign signs a message's UTF-8 bytes and answers base64url without padding,
// the form src/main/device-signature.ts reads.
func (k Key) Sign(message string) (string, error) {
	if k.private == nil {
		return "", ErrNoKey
	}
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.private, []byte(message))), nil
}

// canonical is the RFC 7638 member subset of an OKP key, in lexicographic
// order, byte for byte what JSON.stringify({crv, kty, x}) writes.
func canonical(j JWK) ([]byte, error) {
	if j.Kty != "OKP" || j.Crv != "Ed25519" || j.X == "" {
		return nil, ErrNotOKP
	}
	// The struct's field order (crv, kty, x) IS the canonical order. HTML
	// escaping off and the encoder's newline trimmed, as JSON.stringify writes.
	ordered := struct {
		Crv string `json:"crv"`
		Kty string `json:"kty"`
		X   string `json:"x"`
	}{j.Crv, j.Kty, j.X}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(ordered); err != nil {
		return nil, fmt.Errorf("account: encoding a key: %w", err)
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}

// Thumbprint is the key's RFC 7638 thumbprint, base64url: what a device grant names a key by.
func Thumbprint(j JWK) (string, error) {
	c, err := canonical(j)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// DeviceID is the device's id as a pure function of its key: a version-8 UUID
// from the SHA-256 of the thumbprint's raw bytes.
func DeviceID(j JWK) (string, error) {
	c, err := canonical(j)
	if err != nil {
		return "", err
	}
	thumb := sha256.Sum256(c)
	digest := sha256.Sum256(thumb[:])
	b := digest[:16]
	id := make([]byte, 16)
	copy(id, b)
	id[6] = (id[6] & 0x0f) | 0x80 // version 8: custom
	id[8] = (id[8] & 0x3f) | 0x80 // variant 10: RFC 9562
	h := hex.EncodeToString(id)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}
