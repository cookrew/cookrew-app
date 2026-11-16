package plane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Request is one call to a machine, by its own route (/api/agents).
type Request struct {
	Method string
	Route  string
	Body   []byte
	// ContentType defaults to application/json when there is a body.
	ContentType string
	// Stream marks a long answer (server-sent events): no overall deadline.
	Stream bool
}

// Plane is one road to a machine.
type Plane interface {
	// Name is how the phone shows the road: "relay", "lan" or "tailnet".
	Name() string
	// Do sends one request. A non-nil response is the caller's to close.
	Do(ctx context.Context, req Request) (*http.Response, error)
}

// Credentials are what a request carries. They are read on every call because
// the session renews and a machine token can be replaced while the app runs.
type Credentials interface {
	// Session is the account session token (the relay reads it; never forwarded).
	Session() string
	// MachineToken is this machine's own token for this device (Bearer).
	MachineToken() string
}

var (
	// ErrSessionEnded is the relay's own 401: the account session is over, sign in again.
	ErrSessionEnded = errors.New("plane: the account session has ended")
	// ErrMachineOffline is the relay's 503 no_link: the machine is not connected.
	ErrMachineOffline = errors.New("plane: the machine is not connected to cookrew.dev")
	// ErrRefused is the machine's own 401 or 403: its token for this device is not good.
	ErrRefused = errors.New("plane: the machine refused this device")
)

// relayError is the body the relay answers its own refusals with.
type relayError struct {
	Error string `json:"error"`
}

// maxErrorBody bounds how much of a refusal is read to classify it.
const maxErrorBody = 4 * 1024

// Check turns anything but a 2xx into an error, reading (and closing) the body
// only then. A 3xx is an error too: a plane never follows a redirect.
func Check(resp *http.Response) (*http.Response, error) {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	var said relayError
	_ = json.Unmarshal(raw, &said)
	switch {
	case resp.StatusCode == http.StatusUnauthorized && said.Error == "unauthenticated":
		return nil, ErrSessionEnded
	// 503: the machine is not connected; 502: it went away before answering (v2-canvas-relay.ts).
	case (resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusBadGateway) && said.Error == "no_link":
		return nil, ErrMachineOffline
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%w (%d %s)", ErrRefused, resp.StatusCode, said.Error)
	default:
		return nil, &StatusError{Status: resp.StatusCode, Body: string(raw)}
	}
}

// StatusError is any other refusal, with what the machine said.
type StatusError struct {
	Status int
	Body   string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("plane: the machine answered %d: %s", e.Status, e.Body)
}
