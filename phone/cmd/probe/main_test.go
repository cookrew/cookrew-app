package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func TestRefusesEveryRegistryButThisMachine(t *testing.T) {
	state := filepath.Join(t.TempDir(), "phone.json")
	for _, origin := range []string{"https://cookrew.dev", "https://api.cookrew.dev", "http://192.168.1.4:8790", "https://127.0.0.1.evil.example", "http://localhost.evil:1", "http://localhost:8790"} {
		err := run([]string{"-registry", origin, "-state", state, "machines"}, &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "only talks to a registry on this machine") {
			t.Errorf("%s: %v", origin, err)
		}
	}
}

func TestTakesThisMachineByAddress(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1:8790", "http://[::1]:8790"} {
		if err := loopbackOnly(origin); err != nil {
			t.Errorf("%s: %v", origin, err)
		}
	}
}

func TestNeedsARegistryAndAStateFile(t *testing.T) {
	if err := run([]string{"machines"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("no flags: %v", err)
	}
}

func TestStateIsKeptOwnerOnly(t *testing.T) {
	file := filepath.Join(t.TempDir(), "phone.json")
	if err := save(file, stateFixture()); err != nil {
		t.Fatal(err)
	}
	info, err := statOf(file)
	if err != nil || info&0o777 != 0o600 {
		t.Fatalf("mode %o, %v", info, err)
	}
	back, err := readState(file)
	if err != nil || back.Machines["m"].Token != "t" {
		t.Fatalf("read back %+v %v", back, err)
	}
}
