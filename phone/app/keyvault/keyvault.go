// Package keyvault keeps the phone's secret (its device key and tokens) in the
// platform keychain behind Face ID (owner 2026-11-16): an item written with
// SecAccessControl .biometryCurrentSet, readable on this device only, only
// while it has a passcode, and only after the person whose face or finger is
// enrolled NOW answers the prompt. Enrolling a new face ends the item
// (ErrInvalidated): the phone then joins again with a new code, as a stranger
// added to Face ID must not inherit the way into every Mac.
//
// Saving never prompts; loading does, once, when the app opens. iOS and macOS
// only (swift/); elsewhere NewKeyvault's error wraps errors.ErrUnsupported.
package keyvault

import (
	"context"

	"github.com/egoist/asuka/native"
)

var (
	// ErrNotFound: nothing is kept under the key.
	ErrNotFound = native.NewError("keyvault: nothing kept under that key")
	// ErrCanceled: the person dismissed the prompt, or it failed too many times.
	ErrCanceled = native.NewError("keyvault: Face ID was canceled")
	// ErrNoBiometry: Face ID (or Touch ID) or a passcode is not set up, so nothing can be kept behind it.
	ErrNoBiometry = native.NewError("keyvault: Face ID or a passcode is not set up")
	// ErrInvalidated: the enrolled faces or fingers changed since the item was kept; it can no longer be read.
	ErrInvalidated = native.NewError("keyvault: Face ID changed since this was kept")
	// ErrUnavailable: the keychain is closed for now (the iPhone is locked); nothing was changed, try again later.
	ErrUnavailable = native.NewError("keyvault: the keychain is closed while the iPhone is locked")
)

// Keyvault is the keychain behind Face ID.
//
//asuka:native
type Keyvault interface {
	// Available reports whether a secret can be kept behind Face ID here:
	// biometry enrolled and a passcode set. ErrNoBiometry otherwise.
	Available() (bool, error)
	// Save keeps value under key, replacing what was there. It never prompts.
	Save(ctx context.Context, key string, value []byte) error
	// Load reads key, after the Face ID prompt that shows reason.
	Load(ctx context.Context, key string, reason string) ([]byte, error)
	// Delete forgets key; nothing kept is not an error.
	Delete(key string) error
}
