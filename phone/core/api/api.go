// Package api is the machine's one-shot routes the native client calls
// (src/main/mobile-api.ts), typed: what goes out, what comes back.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// maxBody bounds an answer read whole. The roster lists every agent ever
// spawned (a thousand is ordinary), so it is generous.
const maxBody = 16 << 20

// Entry is one agent of the machine's roster (agent-registry.ts · AgentRegistryEntry).
type Entry struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Preset        string `json:"preset"`
	Command       string `json:"command"`
	Role          string `json:"role"`
	Cwd           string `json:"cwd"`
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
	Orch          bool   `json:"orch"`
	SpawnedAt     int64  `json:"spawnedAt"`
	// Active is false after a dismiss, a kill or the agent's exit.
	Active    bool  `json:"active"`
	UpdatedAt int64 `json:"updatedAt"`
}

// Agents is the machine's roster: GET /api/agents.
func Agents(ctx context.Context, p plane.Plane) ([]Entry, error) {
	var answer struct {
		Agents []Entry `json:"agents"`
	}
	if err := call(ctx, p, plane.Request{Route: "/api/agents"}, &answer); err != nil {
		return nil, fmt.Errorf("api: the roster: %w", err)
	}
	return answer.Agents, nil
}

// terminalID is the shape of a card's id (a uuid, or a slug of one): one
// path segment, nothing that reshapes a route (no '/', '?', '.').
var terminalID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// IsTerminalID reports whether id may name a terminal in a route.
func IsTerminalID(id string) bool { return terminalID.MatchString(id) }

// batchID is the machine's BATCH_ID (once-by-key.ts): a batch sent again
// under the same id is typed once.
var batchID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,80}$`)

// ErrHeld is the machine holding the keys back (a 409: a dispatch is in
// flight, or the submit guard refused): nothing was typed.
var ErrHeld = errors.New("api: the machine held the keys back")

// Raw types data into terminal id: POST /api/terminal/<id>/raw. batch names
// the keys so a retry after a lost answer is typed once; "" sends none.
func Raw(ctx context.Context, p plane.Plane, id, data, batch string) error {
	if !IsTerminalID(id) {
		return fmt.Errorf("api: %q is not a terminal id", id)
	}
	if batch != "" && !batchID.MatchString(batch) {
		return fmt.Errorf("api: %q is not a batch id", batch)
	}
	body, err := json.Marshal(struct {
		Data string `json:"data"`
		ID   string `json:"id,omitempty"`
	}{data, batch})
	if err != nil {
		return err
	}
	err = call(ctx, p, plane.Request{Method: "POST", Route: "/api/terminal/" + id + "/raw", Body: body}, nil)
	var status *plane.StatusError
	if errors.As(err, &status) && status.Status == 409 {
		return fmt.Errorf("%w: %s", ErrHeld, status.Body)
	}
	return err
}

// call sends req and decodes the answer into out (nil: the answer is read and dropped).
func call(ctx context.Context, p plane.Plane, req plane.Request, out any) error {
	resp, err := p.Do(ctx, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return err
	}
	if len(raw) > maxBody {
		return fmt.Errorf("api: an answer over %d bytes", maxBody)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
