package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// The fleet as GET /api/fleet answers it (src/shared/fleet.ts · FleetSnapshot):
// only what these screens show. When phone/core/fleet lands (Asuka Desk's,
// snapshot then deltas over /api/fleet/stream) these screens follow it instead.

type fleetSnapshot struct {
	Machine struct {
		Name string `json:"name"`
	} `json:"machine"`
	FocusedWorkspaceID string           `json:"focusedWorkspaceId"`
	Workspaces         []fleetWorkspace `json:"workspaces"`
}

type fleetWorkspace struct {
	ID     string       `json:"id"`
	Name   string       `json:"name"`
	State  string       `json:"state"`
	Agents []fleetAgent `json:"agents"`
}

type fleetAgent struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Harness string `json:"harness"`
	// Phase is idle, thinking, waiting, replied or offline.
	Phase string `json:"phase"`
	Task  string `json:"task"`
	Reply string `json:"reply"`
}

// maxFleet bounds a snapshot read: a working canvas is a few hundred KB.
const maxFleet = 4 << 20

// readFleet is one snapshot of a machine's fleet.
func readFleet(ctx context.Context, road plane.Plane) (fleetSnapshot, error) {
	resp, err := road.Do(ctx, plane.Request{Method: http.MethodGet, Route: "api/fleet"})
	if err != nil {
		return fleetSnapshot{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxFleet))
	if err != nil {
		return fleetSnapshot{}, fmt.Errorf("reading the fleet: %w", err)
	}
	var snapshot fleetSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return fleetSnapshot{}, fmt.Errorf("decoding the fleet: %w", err)
	}
	return snapshot, nil
}
