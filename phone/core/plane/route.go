// Package plane carries the phone's calls to a machine. A Plane answers one
// request; the rest of the client never learns whether it went through the
// cookrew.dev relay or straight to the machine on the LAN.
package plane

import (
	"net/url"
	"regexp"
	"strings"
)

// RelayPrefix is the relay's path for one machine's routes (src/shared/machine-relay.ts).
const RelayPrefix = "/api/m"

var (
	machineID   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	escapedPath = regexp.MustCompile(`(?i)%2f|%5c|%2e|\\`)
)

// IsMachineID reports whether id is a machine id as the registry keeps it: a lowercase uuid.
func IsMachineID(id string) bool { return machineID.MatchString(id) }

// IsRelayedRoute reports whether the relay carries this route: the machine's
// API (api/…) or its sealed session (~seal/…), and nothing that climbs out.
// The twin of isRelayedRoute in src/shared/machine-relay.ts.
func IsRelayedRoute(route string) bool {
	path, _, _ := strings.Cut(route, "?")
	if escapedPath.MatchString(path) {
		return false
	}
	segments := strings.Split(path, "/")
	if segments[0] != "api" && segments[0] != "~seal" {
		return false
	}
	for _, s := range segments {
		if s == ".." || s == "." {
			return false
		}
	}
	return true
}

// RelayPath is one route of one machine as the relay addresses it, or "" when
// either half is not what it may be. The twin of machineRelayPath.
func RelayPath(machine, route string) string {
	id := strings.ToLower(machine)
	bare := strings.TrimLeft(route, "/")
	if !IsMachineID(id) || !IsRelayedRoute(bare) {
		return ""
	}
	return RelayPrefix + "/" + id + "/" + bare
}

// Seated adds the phone's workspace to a route as ?seat= (renderer device-seat.ts):
// a query, never a header, so the same route works on every plane. An empty
// seat leaves the route alone, and the phone then follows the machine's focus.
func Seated(route, seat string) string {
	if seat == "" {
		return route
	}
	sep := "?"
	if strings.Contains(route, "?") {
		sep = "&"
	}
	return route + sep + "seat=" + url.QueryEscape(seat)
}
