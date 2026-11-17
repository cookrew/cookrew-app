package plane

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestLoopbackSendsTheBearerAndNeverTheSession(t *testing.T) {
	var seen *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	// Credentials that do carry a session: the loopback plane must still not send it.
	lb, err := NewLoopback(server.URL, StaticCredentials("sess", "tok"), server.Client())
	if err != nil {
		t.Fatalf("NewLoopback: %v", err)
	}
	if lb.Name() != "loopback" {
		t.Errorf("Name %q", lb.Name())
	}
	resp, err := lb.Do(context.Background(), Request{Route: Seated("/api/agents", "w1")})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	if seen.URL.Path != "/api/agents" || seen.URL.Query().Get("seat") != "w1" {
		t.Errorf("path %q seat %q", seen.URL.Path, seen.URL.Query().Get("seat"))
	}
	if seen.Header.Get("Authorization") != "Bearer tok" {
		t.Errorf("Authorization %q", seen.Header.Get("Authorization"))
	}
	if got := seen.Header.Values(SessionHeader); len(got) != 0 {
		t.Errorf("the account session went to the machine: %v", got)
	}
}

func TestLoopbackTakesOnlyThisComputer(t *testing.T) {
	creds := StaticCredentials("", "tok")
	for _, origin := range []string{
		"http://127.0.0.1:8639", "http://[::1]:8639", "https://127.0.0.1:8643",
	} {
		if _, err := NewLoopback(origin, creds, nil); err != nil {
			t.Errorf("%s refused: %v", origin, err)
		}
	}
	for _, origin := range []string{
		"http://192.168.1.4:8639",   // the LAN is another plane, pinned
		"http://localhost:8639",     // a name: the hosts file decides where it goes
		"http://127.0.0.1.nip.io",   // a name that only looks like loopback
		"http://127.0.0.1:8639/api", // not a bare origin
		"http://user@127.0.0.1:8639",
		"ftp://127.0.0.1",
		"",
	} {
		if _, err := NewLoopback(origin, creds, nil); err == nil {
			t.Errorf("%q accepted", origin)
		}
	}
	if _, err := NewLoopback("http://127.0.0.1:8639", nil, nil); err == nil {
		t.Error("no credentials accepted")
	}
}

func TestLoopbackCarriesOnlyTheMachinesAPI(t *testing.T) {
	lb, err := NewLoopback("http://127.0.0.1:1", StaticCredentials("", "t"), nil)
	if err != nil {
		t.Fatalf("NewLoopback: %v", err)
	}
	for _, route := range []string{"/assets/app.js", "/~seal/hello", "/api/../index.html", "/api/%2e%2e/x", ""} {
		if _, err := lb.Do(context.Background(), Request{Route: route}); err == nil {
			t.Errorf("%q went to the machine", route)
		}
	}
}

func TestLoopbackNeverFollowsARedirect(t *testing.T) {
	hops := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, "/api/elsewhere", http.StatusFound)
	}))
	defer server.Close()
	lb, _ := NewLoopback(server.URL, StaticCredentials("", "t"), server.Client())
	_, err := lb.Do(context.Background(), Request{Route: "/api/agents"})
	var status *StatusError
	if !errors.As(err, &status) || status.Status != http.StatusFound {
		t.Fatalf("got %v, want the 302 as an error", err)
	}
	if hops != 1 {
		t.Errorf("%d requests: the redirect was followed", hops)
	}
}

func TestLoopbackNamesARefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"Unauthorized"}`)
	}))
	defer server.Close()
	lb, _ := NewLoopback(server.URL, StaticCredentials("", "stale"), server.Client())
	if _, err := lb.Do(context.Background(), Request{Route: "/api/agents"}); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
}

func TestLoopbackUsesNoProxyAndDialsOnlyLoopback(t *testing.T) {
	proxied := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(&url.URL{Scheme: "http", Host: "198.51.100.7:3128"})}}
	lb, err := NewLoopback("http://127.0.0.1:8639", StaticCredentials("", "t"), proxied)
	if err != nil {
		t.Fatal(err)
	}
	tr := lb.client.Transport.(*http.Transport)
	if tr.Proxy != nil {
		t.Error("the caller's proxy was kept: the token would go through it")
	}
	if _, err := tr.DialContext(context.Background(), "tcp", "198.51.100.7:80"); err == nil || !strings.Contains(err.Error(), "not this computer") {
		t.Errorf("dialled a non-loopback address: %v", err)
	}
}
