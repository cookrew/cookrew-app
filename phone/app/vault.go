package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/cookrew/cookrew-app/phone/core/pair"
	"github.com/egoist/asuka/sdk/secure"
)

// stateKey is the keychain item the phone's place on the account is kept in:
// the device key's seed, the session, each machine's token. One item, one
// value (pair.State), so it is read and written whole.
const stateKey = "dev.cookrew.phone.state"

// errNoState is a phone that has not joined an account yet.
var errNoState = errors.New("this phone has not joined an account")

// Vault keeps the phone's state. Its calls wait for the platform: never on
// the main thread. The keychain one here becomes the Face ID one (task 4)
// without anything above it changing.
type Vault interface {
	Load() (pair.State, error)
	Save(pair.State) error
	Clear() error
}

// keychainVault is the platform keychain (asuka/sdk/secure).
type keychainVault struct{}

func (keychainVault) Load() (pair.State, error) {
	raw, ok, err := secure.Get(stateKey)
	if err != nil {
		return pair.State{}, fmt.Errorf("reading the keychain: %w", err)
	}
	if !ok {
		return pair.State{}, errNoState
	}
	var state pair.State
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return pair.State{}, fmt.Errorf("the kept state is unreadable: %w", err)
	}
	return state, nil
}

func (keychainVault) Save(state pair.State) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return secure.Set(stateKey, string(raw))
}

func (keychainVault) Clear() error { return secure.Delete(stateKey) }
