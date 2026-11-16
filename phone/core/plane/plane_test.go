package plane

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const machine = "6c1f3a52-0e9b-4c7d-8a21-5f0d9e3b7c41"

// The relay paths TypeScript computes (tests/phone-account-vectors.test.ts).
func TestRelayPathMatchesTheTypeScriptTwin(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "phone-contract", "account-vectors.json"))
	if err != nil {
		t.Fatalf("reading the shared vectors: %v", err)
	}
	var v struct {
		RelayPaths []struct {
			MachineID string  `json:"machineId"`
			Route     string  `json:"route"`
			Path      *string `json:"path"`
		} `json:"relayPaths"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if len(v.RelayPaths) == 0 {
		t.Fatal("no relay paths in the vectors")
	}
	for _, c := range v.RelayPaths {
		want := ""
		if c.Path != nil {
			want = *c.Path
		}
		if got := RelayPath(c.MachineID, c.Route); got != want {
			t.Errorf("RelayPath(%q): got %q, TypeScript says %q", c.Route, got, want)
		}
	}
}

func TestSeated(t *testing.T) {
	cases := []struct{ route, seat, want string }{
		{"/api/agents", "", "/api/agents"},
		{"/api/agents", "w1", "/api/agents?seat=w1"},
		{"/api/turns?limit=5", "w 2", "/api/turns?limit=5&seat=w+2"},
	}
	for _, c := range cases {
		if got := Seated(c.route, c.seat); got != c.want {
			t.Errorf("Seated(%q, %q) = %q, want %q", c.route, c.seat, got, c.want)
		}
	}
}

func TestRelaySendsTheTwoCredentialsOnThePathForm(t *testing.T) {
	var seen *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	if _, err := NewRelay("http://cookrew.dev", machine, StaticCredentials("sess", "tok"), nil); err == nil {
		t.Fatal("an http:// relay that is not loopback should be refused")
	}
	relay, err := NewRelay(server.URL, machine, StaticCredentials("sess", "tok"), server.Client())
	if err != nil {
		t.Fatalf("NewRelay: %v", err)
	}
	resp, err := relay.Do(context.Background(), Request{Route: Seated("/api/agents", "w1")})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if seen.URL.Path != "/api/m/"+machine+"/api/agents" || seen.URL.Query().Get("seat") != "w1" {
		t.Errorf("path %q seat %q", seen.URL.Path, seen.URL.Query().Get("seat"))
	}
	if seen.Header.Get("Authorization") != "Bearer tok" || seen.Header.Get(SessionHeader) != "sess" {
		t.Errorf("headers %v", seen.Header)
	}
}

func TestRelayRefusesARouteItDoesNotCarry(t *testing.T) {
	relay, err := NewRelay("https://cookrew.dev", machine, StaticCredentials("s", "t"), nil)
	if err != nil {
		t.Fatalf("NewRelay: %v", err)
	}
	if _, err := relay.Do(context.Background(), Request{Route: "/assets/app.js"}); err == nil {
		t.Fatal("a page asset went to the relay")
	}
}

func TestCheckNamesTheRefusals(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   error
	}{
		{401, `{"error":"unauthenticated"}`, ErrSessionEnded},
		{503, `{"error":"no_link"}`, ErrMachineOffline},
		{401, `{}`, ErrRefused},
		{403, `{"error":"scope"}`, ErrRefused},
	}
	for _, c := range cases {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			_, _ = io.WriteString(w, c.body)
		}))
		relay, _ := NewRelay(server.URL, machine, StaticCredentials("s", "t"), server.Client())
		_, err := relay.Do(context.Background(), Request{Route: "/api/agents"})
		if !errors.Is(err, c.want) {
			t.Errorf("%d %s: got %v, want %v", c.status, c.body, err, c.want)
		}
		server.Close()
	}
	var status *StatusError
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		_, _ = io.WriteString(w, `{"error":"SEAT_GONE"}`)
	}))
	defer server.Close()
	relay, _ := NewRelay(server.URL, machine, StaticCredentials("s", "t"), server.Client())
	if _, err := relay.Do(context.Background(), Request{Route: "/api/agents"}); !errors.As(err, &status) || status.Status != 409 {
		t.Errorf("a 409 should be a StatusError, got %v", err)
	}
}

func TestRelayNeverFollowsARedirectWithTheSession(t *testing.T) {
	var leaked []string
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = append(leaked, r.Header.Get(SessionHeader))
	}))
	defer elsewhere.Close()
	relayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/steal", http.StatusFound)
	}))
	defer relayServer.Close()
	relay, err := NewRelay(relayServer.URL, machine, StaticCredentials("SESSION", "TOKEN"), relayServer.Client())
	if err != nil {
		t.Fatalf("NewRelay: %v", err)
	}
	var status *StatusError
	if _, err := relay.Do(context.Background(), Request{Route: "/api/agents"}); !errors.As(err, &status) || status.Status != http.StatusFound {
		t.Fatalf("a redirect should come back as a StatusError 302, got %v", err)
	}
	if len(leaked) != 0 {
		t.Fatalf("the redirect was followed and carried %q", leaked)
	}
}

func TestRelayAcceptsOnlyABareSafeOrigin(t *testing.T) {
	refused := []string{
		"http://cookrew.dev",
		"http://localhost.attacker.example",
		"http://127.0.0.1.nip.io",
		"https://user:pw@cookrew.dev",
		"https://cookrew.dev/api",
		"https://cookrew.dev?x=1",
		"cookrew.dev",
	}
	for _, api := range refused {
		if _, err := NewRelay(api, machine, StaticCredentials("s", "t"), nil); err == nil {
			t.Errorf("NewRelay(%q) was accepted", api)
		}
	}
	for _, api := range []string{"https://cookrew.dev", "https://cookrew.dev/", "http://127.0.0.1:8787", "http://localhost:1", "http://[::1]:9"} {
		if _, err := NewRelay(api, machine, StaticCredentials("s", "t"), nil); err != nil {
			t.Errorf("NewRelay(%q): %v", api, err)
		}
	}
}

func TestMachineHeadersNeverCarryTheSession(t *testing.T) {
	h := MachineHeaders(StaticCredentials("SESSION", "TOKEN"), Request{Stream: true, Body: []byte("{}")})
	if h.Get(SessionHeader) != "" {
		t.Fatal("the account session is in a machine's headers")
	}
	if h.Get("Authorization") != "Bearer TOKEN" || h.Get("Accept-Encoding") != "identity" || h.Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", h)
	}
}

func TestA502NoLinkIsOffline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"no_link"}`)
	}))
	defer server.Close()
	relay, _ := NewRelay(server.URL, machine, StaticCredentials("s", "t"), server.Client())
	if _, err := relay.Do(context.Background(), Request{Route: "/api/agents"}); !errors.Is(err, ErrMachineOffline) {
		t.Fatalf("got %v, want ErrMachineOffline", err)
	}
}
