package plane

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// SessionHeader carries the account session to the relay (src/shared/machine-relay.ts).
// Only the relay plane sends it: the relay reads it and never forwards it, and
// no other plane may hand the account session to a machine.
const SessionHeader = "x-cookrew-session"

// Relay reaches a machine through cookrew.dev: <api>/api/m/<machine>/<route>,
// the account session in x-cookrew-session (read by the relay, not forwarded)
// and the machine's token as Bearer (passed through unread).
type Relay struct {
	api     string
	machine string
	creds   Credentials
	client  *http.Client
}

// NewRelay is a relay plane to one machine. api is the registry origin
// (https://cookrew.dev, or plain http on loopback for tests); client nil means
// a default one. The client is copied and never follows a redirect: Go keeps
// custom headers across one, so a 3xx would carry the session to another host.
func NewRelay(api, machine string, creds Credentials, client *http.Client) (Relay, error) {
	id := strings.ToLower(machine)
	if !IsMachineID(id) {
		return Relay{}, fmt.Errorf("plane: %q is not a machine id", machine)
	}
	origin, err := relayOrigin(api)
	if err != nil {
		return Relay{}, err
	}
	if creds == nil {
		return Relay{}, errors.New("plane: a relay needs credentials")
	}
	return Relay{api: origin, machine: id, creds: creds, client: noRedirects(client)}, nil
}

// relayOrigin accepts a bare origin: https anywhere, http only on loopback.
func relayOrigin(api string) (string, error) {
	u, err := url.Parse(api)
	if err != nil {
		return "", fmt.Errorf("plane: the relay address %q: %w", api, err)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return "", fmt.Errorf("plane: the relay address must be a bare origin (got %q)", api)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && isLoopback(u.Hostname()):
	default:
		return "", fmt.Errorf("plane: the relay must be https (got %q)", api)
	}
	return u.Scheme + "://" + u.Host, nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func noRedirects(client *http.Client) *http.Client {
	base := http.Client{}
	if client != nil {
		base = *client
	}
	base.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &base
}

// Name is "relay".
func (r Relay) Name() string { return "relay" }

// Do sends one request down the relay.
func (r Relay) Do(ctx context.Context, req Request) (*http.Response, error) {
	path := RelayPath(r.machine, req.Route)
	if path == "" {
		return nil, fmt.Errorf("plane: the relay does not carry %q", req.Route)
	}
	header := MachineHeaders(r.creds, req)
	if session := r.creds.Session(); session != "" {
		header.Set(SessionHeader, session)
	}
	return exchange(ctx, r.client, r.api+path, req, header, "relay")
}

// MachineHeaders are what a request carries for the machine itself, on any
// plane: its Bearer token, the body's type, and stream hints. Never the account session.
func MachineHeaders(creds Credentials, req Request) http.Header {
	h := http.Header{}
	if token := creds.MachineToken(); token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
	if len(req.Body) > 0 {
		contentType := req.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		h.Set("Content-Type", contentType)
	}
	if req.Stream {
		h.Set("Accept", "text/event-stream")
		// A compressed stream is buffered by something on the way; ask for none.
		h.Set("Accept-Encoding", "identity")
	}
	return h
}
