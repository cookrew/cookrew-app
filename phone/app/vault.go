package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/cookrew/cookrew-app/phone/app/keyvault"
	"github.com/cookrew/cookrew-app/phone/core/pair"
)

// stateKey is the keychain item the phone's place on the account is kept in:
// the device key's seed, the session, each machine's token. One item, one
// value (pair.State), so it is read and written whole.
const stateKey = "dev.cookrew.phone.state"

// openReason is what the Face ID prompt says when the app opens.
const openReason = "Open your Cookrew key to reach your Macs."

// vaultTimeout bounds one keychain call; a prompt left open that long is given up.
const vaultTimeout = 2 * time.Minute

var (
	// errNoState is a phone that has not joined an account yet.
	errNoState = errors.New("this phone has not joined an account")
	// errNoFaceID: the owner's rule is the key behind Face ID, and there is none to put it behind.
	errNoFaceID = errors.New("set up Face ID and a passcode on this iPhone first: Cookrew keeps its key behind them")
	// errFaceIDChanged: a face was added or removed since the key was kept; the next code joins again.
	errFaceIDChanged = errors.New("Face ID changed on this iPhone, so its Cookrew key was closed for good; scan a new code from ⋯ → Phone app")
	// errCanceled: Face ID was not answered.
	errCanceled = errors.New("Cookrew's key stays closed until Face ID answers")
	// errKeychainClosed: the iPhone is locked; nothing was read or changed.
	errKeychainClosed = errors.New("the keychain is closed while the iPhone is locked; try again once it is unlocked")
)

// Vault keeps the phone's state. Its calls wait for the platform (and Load
// for Face ID): never on the main thread.
type Vault interface {
	Load() (pair.State, error)
	Save(pair.State) error
	Clear() error
}

// faceVault is the keychain behind Face ID (keyvault, our own native package).
type faceVault struct {
	keys keyvault.Keyvault

	mu sync.Mutex
	// written is the JSON last kept: a state that has not changed is not written again.
	written []byte
}

// newFaceVault is the platform's keychain behind Face ID.
func newFaceVault() (*faceVault, error) {
	keys, err := keyvault.NewKeyvault()
	if err != nil {
		return nil, fmt.Errorf("the keychain behind Face ID: %w", err)
	}
	return &faceVault{keys: keys}, nil
}

func (v *faceVault) Load() (pair.State, error) {
	ctx, cancel := context.WithTimeout(context.Background(), vaultTimeout)
	defer cancel()
	raw, err := v.keys.Load(ctx, stateKey, openReason)
	switch {
	case errors.Is(err, keyvault.ErrNotFound):
		return pair.State{}, errNoState
	case errors.Is(err, keyvault.ErrInvalidated):
		// The item is unreadable for good: let it go, so the next code joins a new key.
		if clearErr := v.keys.Delete(stateKey); clearErr != nil {
			return pair.State{}, fmt.Errorf("%w (and it could not be cleared: %v)", errFaceIDChanged, clearErr)
		}
		return pair.State{}, errFaceIDChanged
	case errors.Is(err, keyvault.ErrCanceled):
		return pair.State{}, errCanceled
	case errors.Is(err, keyvault.ErrUnavailable):
		return pair.State{}, errKeychainClosed
	case errors.Is(err, keyvault.ErrNoBiometry):
		return pair.State{}, errNoFaceID
	case err != nil:
		return pair.State{}, fmt.Errorf("reading the keychain: %w", err)
	}
	var state pair.State
	if err := json.Unmarshal(raw, &state); err != nil {
		return pair.State{}, fmt.Errorf("the kept state is unreadable: %w", err)
	}
	v.mu.Lock()
	v.written = raw
	v.mu.Unlock()
	return state, nil
}

// Save keeps the state, unless it is what was last kept. One save at a time.
func (v *faceVault) Save(state pair.State) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if bytes.Equal(raw, v.written) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), vaultTimeout)
	defer cancel()
	switch err := v.keys.Save(ctx, stateKey, raw); {
	case errors.Is(err, keyvault.ErrNoBiometry):
		return errNoFaceID
	case errors.Is(err, keyvault.ErrUnavailable):
		return errKeychainClosed
	case err != nil:
		return fmt.Errorf("keeping the key: %w", err)
	}
	v.written = raw
	return nil
}

func (v *faceVault) Clear() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.written = nil
	return v.keys.Delete(stateKey)
}
