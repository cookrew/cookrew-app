package plane

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Loopback reaches the machine this app runs on: its own server on
// 127.0.0.1 (the desktop app beside the Cookrew it shows). The machine's
// token goes as Bearer; the account session never does, whatever the
// credentials hold: it is the relay's to read, and no machine's.
type Loopback struct {
	origin string
	creds  Credentials
	client *http.Client
}

// NewLoopback is a plane to this computer's machine at origin, a bare
// http(s) origin on 127.0.0.1 or [::1]: an address, never a name, which a
// hosts file or a resolver could point elsewhere. client nil means a default
// one; it is copied, never follows a redirect, never uses a proxy, and dials
// only loopback addresses whatever its transport would.
func NewLoopback(origin string, creds Credentials, client *http.Client) (Loopback, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return Loopback{}, fmt.Errorf("plane: the loopback address %q: %w", origin, err)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return Loopback{}, fmt.Errorf("plane: the loopback address must be a bare origin (got %q)", origin)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return Loopback{}, fmt.Errorf("plane: the loopback address must be http or https (got %q)", origin)
	}
	if ip := net.ParseIP(u.Hostname()); ip == nil || !ip.IsLoopback() {
		return Loopback{}, fmt.Errorf("plane: %q is not this computer's address", u.Hostname())
	}
	if creds == nil {
		return Loopback{}, errors.New("plane: a loopback plane needs credentials")
	}
	return Loopback{origin: u.Scheme + "://" + u.Host, creds: creds, client: loopbackOnly(noRedirects(client))}, nil
}

// loopbackOnly gives c a transport that goes straight to loopback addresses:
// no proxy (which would carry the token off this computer), and a dial that
// refuses any other address. A transport that is not an *http.Transport is
// replaced by the default one.
func loopbackOnly(c *http.Client) *http.Client {
	base, ok := c.Transport.(*http.Transport)
	if !ok || base == nil {
		base = http.DefaultTransport.(*http.Transport)
	}
	t := base.Clone()
	t.Proxy = nil
	dial := t.DialContext
	if dial == nil {
		dial = (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	}
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("plane: %s is not this computer", addr)
		}
		return dial(ctx, network, addr)
	}
	c.Transport = t
	return c
}

// Name is "loopback".
func (l Loopback) Name() string { return "loopback" }

// Do sends one request to the machine's own API.
func (l Loopback) Do(ctx context.Context, req Request) (*http.Response, error) {
	route := strings.TrimLeft(req.Route, "/")
	if !IsRelayedRoute(route) || !strings.HasPrefix(route, "api/") {
		return nil, fmt.Errorf("plane: the loopback plane does not carry %q", req.Route)
	}
	return exchange(ctx, l.client, l.origin+"/"+route, req, MachineHeaders(l.creds, req), "loopback")
}
