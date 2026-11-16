package pair

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/account"
)

// DeviceKind is what the phone calls itself on the account. A phone's join
// code makes only this kind, and marks it a trusted phone.
const DeviceKind = "phone"

// callTimeout bounds one registry call.
const callTimeout = 20 * time.Second

// maxBody bounds what is read from any registry answer.
const maxBody = 256 * 1024

// Session is the phone's sign-in on the account. Exp is the registry's, in milliseconds.
type Session struct {
	Token    string `json:"token"`
	Exp      int64  `json:"exp"`
	DeviceID string `json:"deviceId"`
	Username string `json:"username"`
}

// Pass is the account's phone pass: twelve hours, for this device's key, every machine.
type Pass struct {
	Grant    string `json:"grant"`
	Exp      int64  `json:"exp"`
	DeviceID string `json:"deviceId"`
}

// Desktop is one machine of the account as /v2/me/desktops lists it.
type Desktop struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	// Online is the relay's word: false means the machine holds no line now.
	Online bool `json:"online"`
}

// Device is the phone as the account and the machines see it.
type Device struct {
	ID   string
	Name string
	Key  account.Key
}

// NewDevice names a key: the id is the key's own (account.DeviceID).
func NewDevice(key account.Key, name string) (Device, error) {
	jwk, err := key.JWK()
	if err != nil {
		return Device{}, err
	}
	id, err := account.DeviceID(jwk)
	if err != nil {
		return Device{}, err
	}
	return Device{ID: id, Name: name, Key: key}, nil
}

// Refusal is the registry saying no, with its own error word ("bad_credentials", "not_phone", …).
type Refusal struct {
	Status  int
	Reason  string
	Message string
}

func (r *Refusal) Error() string {
	if r.Message != "" {
		return fmt.Sprintf("pair: cookrew.dev answered %d %s: %s", r.Status, r.Reason, r.Message)
	}
	return fmt.Sprintf("pair: cookrew.dev answered %d %s", r.Status, r.Reason)
}

var (
	// ErrWrongCode: the code was wrong, expired or already spent (the registry will not say which).
	ErrWrongCode = errors.New("pair: that code is wrong, ran out or was used")
	// ErrSignedOut: the session is over (revoked, a password change, thirty days): scan a new code.
	ErrSignedOut = errors.New("pair: this phone's sign-in is over; scan a new code")
	// ErrNotTrusted: the account does not know this device as a trusted phone (a password change or "Not me" ended it).
	ErrNotTrusted = errors.New("pair: this phone is not trusted on the account any more; scan a new code")
)

// Registry is cookrew.dev's API, as the phone uses it.
type Registry struct {
	origin string
	client *http.Client
}

// NewRegistry is a client for one registry origin: https anywhere, plain http
// only on loopback (a local registry under test). It never follows a redirect.
func NewRegistry(origin string, client *http.Client) (Registry, error) {
	clean, err := Origin(origin)
	if err != nil {
		return Registry{}, err
	}
	base := http.Client{}
	if client != nil {
		base = *client
	}
	base.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return Registry{origin: clean, client: &base}, nil
}

// Origin is a bare origin, https or loopback http, or an error.
func Origin(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return "", fmt.Errorf("pair: the registry address %q: %w", origin, err)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return "", fmt.Errorf("pair: the registry address must be a bare origin (got %q)", origin)
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && IsLoopback(u.Hostname()):
	default:
		return "", fmt.Errorf("pair: the registry must be https (got %q)", origin)
	}
	return u.Scheme + "://" + u.Host, nil
}

// IsLoopback reports whether a host name is this machine.
func IsLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Origin is the registry this client talks to.
func (r Registry) Origin() string { return r.origin }

type wireDevice struct {
	ID   string      `json:"id"`
	Kind string      `json:"kind"`
	Name string      `json:"name"`
	JWK  account.JWK `json:"jwk"`
}

// Join spends a phone's join code: the phone is on the account, and trusted.
func (r Registry) Join(ctx context.Context, code string, device Device) (Session, error) {
	jwk, err := device.Key.JWK()
	if err != nil {
		return Session{}, err
	}
	body := map[string]any{"code": code, "device": wireDevice{ID: device.ID, Kind: DeviceKind, Name: device.Name, JWK: jwk}}
	var out Session
	status, err := r.call(ctx, http.MethodPost, "/v2/join", "", body, &out)
	if err != nil {
		if status == http.StatusUnauthorized {
			return Session{}, ErrWrongCode
		}
		return Session{}, err
	}
	if out.Token == "" || out.DeviceID != device.ID {
		return Session{}, fmt.Errorf("pair: cookrew.dev joined a device other than this phone")
	}
	return out, nil
}

// PhonePass asks for this phone's pass into every machine: no proof, a trusted phone only.
func (r Registry) PhonePass(ctx context.Context, session string) (Pass, error) {
	var out Pass
	status, err := r.call(ctx, http.MethodPost, "/v2/me/device-grant/phone", session, map[string]any{}, &out)
	if err != nil {
		var refused *Refusal
		switch {
		case status == http.StatusUnauthorized:
			return Pass{}, ErrSignedOut
		case errors.As(err, &refused) && refused.Reason == "not_phone":
			return Pass{}, ErrNotTrusted
		}
		return Pass{}, err
	}
	if out.Grant == "" {
		return Pass{}, fmt.Errorf("pair: cookrew.dev answered no pass")
	}
	return out, nil
}

// Desktops lists the account's machines.
func (r Registry) Desktops(ctx context.Context, session string) ([]Desktop, error) {
	var out []Desktop
	status, err := r.call(ctx, http.MethodGet, "/v2/me/desktops", session, nil, &out)
	if err != nil {
		if status == http.StatusUnauthorized {
			return nil, ErrSignedOut
		}
		return nil, err
	}
	return out, nil
}

// Renew trades the session for a new one, on the device key, before it ends (cookrew-renew/1).
func (r Registry) Renew(ctx context.Context, current Session, key account.Key) (Session, error) {
	var nonce struct {
		Nonce string `json:"nonce"`
	}
	if _, err := r.call(ctx, http.MethodGet, "/v2/sessions/renew-nonce", "", nil, &nonce); err != nil {
		return Session{}, err
	}
	message, err := account.RenewMessage(current.Username, current.DeviceID, nonce.Nonce)
	if err != nil {
		return Session{}, err
	}
	sig, err := key.Sign(message)
	if err != nil {
		return Session{}, err
	}
	var out Session
	status, err := r.call(ctx, http.MethodPost, "/v2/sessions/renew", "", map[string]any{"device": current.DeviceID, "nonce": nonce.Nonce, "sig": sig}, &out)
	if err != nil {
		if status == http.StatusUnauthorized {
			return Session{}, ErrSignedOut
		}
		return Session{}, err
	}
	if out.Token == "" || out.DeviceID != current.DeviceID {
		return Session{}, fmt.Errorf("pair: cookrew.dev renewed a device other than this phone")
	}
	return out, nil
}

// call sends one JSON request and decodes a 2xx answer into out. The status is
// answered whatever happened, 0 when nothing came back.
func (r Registry) call(ctx context.Context, method, path, session string, body any, out any) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, fmt.Errorf("pair: encoding %s: %w", path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, r.origin+path, reader)
	if err != nil {
		return 0, fmt.Errorf("pair: building %s %s: %w", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if session != "" {
		req.Header.Set("Authorization", "Bearer "+session)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("pair: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return resp.StatusCode, fmt.Errorf("pair: reading %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var said struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &said)
		return resp.StatusCode, &Refusal{Status: resp.StatusCode, Reason: said.Error, Message: said.Message}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return resp.StatusCode, fmt.Errorf("pair: decoding %s: %w", path, err)
	}
	return resp.StatusCode, nil
}
