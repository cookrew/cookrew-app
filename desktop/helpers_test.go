package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/fleet"
)

func TestReadToken(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if tok, err := readToken(write("ok", "abc123\n")); err != nil || tok != "abc123" {
		t.Errorf("got %q %v", tok, err)
	}
	for name, body := range map[string]string{"empty": " \n", "two": "a b", "huge": strings.Repeat("x", maxToken+1)} {
		if _, err := readToken(write(name, body)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := readToken(filepath.Join(dir, "missing")); err == nil {
		t.Error("a missing file accepted")
	}
}

func TestConnectHoldsToLoopback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".cookrew"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".cookrew", "pairing-token"), []byte("tok"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COOKREW_NATIVE_ORIGIN", "http://192.168.1.9:8639")
	if _, err := connect(); err == nil {
		t.Error("a LAN origin accepted: the pairing token would leave this computer")
	}
	t.Setenv("COOKREW_NATIVE_ORIGIN", "")
	p, err := connect()
	if err != nil || p.Name() != "loopback" {
		t.Errorf("default: %v %v", p, err)
	}
}

func TestSince(t *testing.T) {
	now := time.UnixMilli(10_000_000_000)
	cases := map[int64]string{
		0:                          "",
		now.UnixMilli() - 5e3:      "now",
		now.UnixMilli() - 4*6e4:    "4m",
		now.UnixMilli() - 3*3.6e6:  "3h",
		now.UnixMilli() - 72*3.6e6: "3d",
	}
	for ms, want := range cases {
		if got := since(ms, now); got != want {
			t.Errorf("since(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestLatestLine(t *testing.T) {
	thinking := fleet.Agent{Phase: "thinking", Status: "Kneading…", Reply: "old"}
	if got := latestLine(thinking); got != "working · Kneading…" {
		t.Errorf("thinking: %q", got)
	}
	replied := fleet.Agent{Phase: "replied", Reply: "done"}
	if got := latestLine(replied); got != "replied · done" {
		t.Errorf("replied: %q", got)
	}
	if got := latestLine(fleet.Agent{Phase: "weird"}); got != "offline" {
		t.Errorf("unknown phase: %q", got)
	}
}

func TestPickWorkspaceFollowsTheIDNotTheIndex(t *testing.T) {
	t.Setenv("COOKREW_NATIVE_WORKSPACE", "")
	list := []string{"a", "c"} // "b", before "c", has gone
	if got := pickWorkspace(list, "c", "a"); got != 1 {
		t.Errorf("chosen c: got %d", got)
	}
	if got := pickWorkspace(list, "b", "a"); got != 0 {
		t.Errorf("chosen gone: want the focused one, got %d", got)
	}
	if got := pickWorkspace(list, "", "zz"); got != 0 {
		t.Errorf("nothing known: got %d", got)
	}
}
