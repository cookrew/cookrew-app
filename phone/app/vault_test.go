package main

import (
	"context"
	"errors"
	"testing"

	"github.com/cookrew/cookrew-app/phone/app/keyvault"
	"github.com/cookrew/cookrew-app/phone/core/pair"
)

// fakeKeys is the keychain behind Face ID, as the vault sees it.
type fakeKeys struct {
	items   map[string][]byte
	loadErr error
	saveErr error
	reasons []string
	deleted []string
}

func (f *fakeKeys) Available() (bool, error) { return true, nil }

func (f *fakeKeys) Save(_ context.Context, key string, value []byte) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.items[key] = append([]byte(nil), value...)
	return nil
}

func (f *fakeKeys) Load(_ context.Context, key, reason string) ([]byte, error) {
	f.reasons = append(f.reasons, reason)
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	v, ok := f.items[key]
	if !ok {
		return nil, keyvault.ErrNotFound
	}
	return v, nil
}

func (f *fakeKeys) Delete(key string) error {
	f.deleted = append(f.deleted, key)
	delete(f.items, key)
	return nil
}

func TestTheStateRoundTripsBehindFaceID(t *testing.T) {
	keys := &fakeKeys{items: map[string][]byte{}}
	v := &faceVault{keys: keys}
	if _, err := v.Load(); !errors.Is(err, errNoState) {
		t.Fatalf("empty vault: %v", err)
	}
	kept := pair.State{Registry: "https://api.cookrew.dev", Seed: "00", Machines: map[string]pair.Machine{"m": {ID: "m", Token: "t"}}}
	if err := v.Save(kept); err != nil {
		t.Fatal(err)
	}
	back, err := v.Load()
	if err != nil || back.Machines["m"].Token != "t" || back.Seed != "00" {
		t.Fatalf("read back %+v %v", back, err)
	}
	// Every read says why it asks for Face ID.
	if keys.reasons[len(keys.reasons)-1] != openReason {
		t.Fatalf("prompt said %q", keys.reasons)
	}
}

func TestWhatFaceIDSaysBecomesWordsAndActs(t *testing.T) {
	cases := []struct {
		err     error
		want    error
		cleared bool
	}{
		{keyvault.ErrCanceled, errCanceled, false},
		{keyvault.ErrNoBiometry, errNoFaceID, false},
		// Faces changed: the key is closed for good, and let go so the next code joins a new one.
		{keyvault.ErrInvalidated, errFaceIDChanged, true},
	}
	for _, c := range cases {
		keys := &fakeKeys{items: map[string][]byte{stateKey: []byte("{}")}, loadErr: c.err}
		_, err := (&faceVault{keys: keys}).Load()
		if !errors.Is(err, c.want) {
			t.Errorf("%v: got %v, want %v", c.err, err, c.want)
		}
		if cleared := len(keys.deleted) > 0; cleared != c.cleared {
			t.Errorf("%v: cleared=%v", c.err, cleared)
		}
	}
}

func TestNoFaceIDMeansNothingIsKept(t *testing.T) {
	keys := &fakeKeys{items: map[string][]byte{}, saveErr: keyvault.ErrNoBiometry}
	if err := (&faceVault{keys: keys}).Save(pair.State{Seed: "00"}); !errors.Is(err, errNoFaceID) {
		t.Fatalf("save without Face ID: %v", err)
	}
	if len(keys.items) != 0 {
		t.Fatal("kept the key with no Face ID to keep it behind")
	}
}

func TestAnUnchangedStateIsNotWrittenAgain(t *testing.T) {
	keys := &countingKeys{fakeKeys: fakeKeys{items: map[string][]byte{}}}
	v := &faceVault{keys: keys}
	state := pair.State{Seed: "00", Machines: map[string]pair.Machine{}}
	for i := 0; i < 3; i++ {
		if err := v.Save(state); err != nil {
			t.Fatal(err)
		}
	}
	if keys.saves != 1 {
		t.Fatalf("%d keychain writes for one state", keys.saves)
	}
	if err := v.Save(state.WithMachine(pair.Machine{ID: "m"})); err != nil || keys.saves != 2 {
		t.Fatalf("a changed state: %v, %d writes", err, keys.saves)
	}
	// A failed write is not remembered as written: the next save tries again.
	keys.saveErr = keyvault.ErrUnavailable
	changed := state.WithMachine(pair.Machine{ID: "n"})
	if err := v.Save(changed); !errors.Is(err, errKeychainClosed) {
		t.Fatalf("locked iPhone: %v", err)
	}
	keys.saveErr = nil
	if err := v.Save(changed); err != nil || keys.saves != 3 {
		t.Fatalf("retry after a failed write: %v, %d writes", err, keys.saves)
	}
}

func TestALockedIPhoneKeepsTheKeyClosedNotGone(t *testing.T) {
	keys := &fakeKeys{items: map[string][]byte{stateKey: []byte("{}")}, loadErr: keyvault.ErrUnavailable}
	if _, err := (&faceVault{keys: keys}).Load(); !errors.Is(err, errKeychainClosed) || len(keys.deleted) != 0 {
		t.Fatalf("locked: %v, deleted %v", err, keys.deleted)
	}
}

func TestOnlyNothingKeptOrAKeyGoneForGoodShowsTheScanner(t *testing.T) {
	cases := map[error]Phase{
		errNoState:                     Joining,
		errFaceIDChanged:               Joining,
		errCanceled:                    Locked,
		errKeychainClosed:              Locked,
		errNoFaceID:                    Locked,
		errors.New("anything unknown"): Locked,
	}
	for err, want := range cases {
		if got := afterLoad(err); got != want {
			t.Errorf("afterLoad(%v) = %v, want %v", err, got, want)
		}
	}
	if afterLoad(nil) != Joined {
		t.Error("a loaded state is not joined")
	}
}

// countingKeys counts the keychain writes that went through.
type countingKeys struct {
	fakeKeys
	saves int
}

func (c *countingKeys) Save(ctx context.Context, key string, value []byte) error {
	if err := c.fakeKeys.Save(ctx, key, value); err != nil {
		return err
	}
	c.saves++
	return nil
}
