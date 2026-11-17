// Package fleet reads a machine's fleet feed (src/shared/fleet.ts): every
// workspace and its agents, as a snapshot and then deltas, each numbered
// (rev). A rev that is not the last one plus one is a gap: the reader drops
// the stream and opens it again, which starts with a fresh snapshot.
package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
)

// Snapshot is the fleet at one rev (FleetSnapshot).
type Snapshot struct {
	V                  int         `json:"v"`
	Rev                int64       `json:"rev"`
	At                 int64       `json:"at"`
	Machine            Machine     `json:"machine"`
	FocusedWorkspaceID string      `json:"focusedWorkspaceId"`
	Workspaces         []Workspace `json:"workspaces"`
}

// Machine is the desktop that serves the feed.
type Machine struct {
	Name       string `json:"name"`
	AppVersion string `json:"appVersion"`
	Profile    struct {
		Kind  string `json:"kind"`
		Label string `json:"label"`
	} `json:"profile"`
}

// Workspace is one canvas and its agents (FleetWorkspace).
type Workspace struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Icon   string   `json:"icon"`
	Traits []string `json:"traits"`
	// State is "focused" (the one the desktop shows) or "background".
	State  string  `json:"state"`
	Agents []Agent `json:"agents"`
	Counts struct {
		Agents   int `json:"agents"`
		Notes    int `json:"notes"`
		Browsers int `json:"browsers"`
	} `json:"counts"`
}

// Agent is one agent card (FleetAgent).
type Agent struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Orch    bool   `json:"orch"`
	// Phase is idle, thinking, waiting, replied or offline.
	Phase string `json:"phase"`
	// PhaseSource is live, probe or ledger: only live is a mirrored screen's.
	PhaseSource string `json:"phaseSource"`
	PhaseSince  int64  `json:"phaseSince"`
	Task        string `json:"task"`
	Reply       string `json:"reply"`
	Status      string `json:"status"`
	Turns       int    `json:"turns"`
}

// Event is one frame of the feed (FleetEvent).
type Event struct {
	Type        string     `json:"type"`
	Rev         int64      `json:"rev"`
	Snapshot    *Snapshot  `json:"snapshot"`
	WorkspaceID string     `json:"workspaceId"`
	Agent       *Agent     `json:"agent"`
	Workspace   *Workspace `json:"workspace"`
}

// ErrGap is a delta that does not follow the snapshot it is applied to.
var ErrGap = errors.New("fleet: a gap in the feed")

// Apply is s after e. s is never changed: what changed is copied. A
// snapshot replaces everything; a delta must carry s.Rev+1. An event this
// reader does not know only moves the rev on, as a newer desktop may send one.
func Apply(s Snapshot, e Event) (Snapshot, error) {
	if e.Type == "snapshot" {
		if e.Snapshot == nil {
			return s, errors.New("fleet: a snapshot event without its snapshot")
		}
		return *e.Snapshot, nil
	}
	if s.V == 0 || e.Rev != s.Rev+1 {
		return s, fmt.Errorf("%w: rev %d after %d", ErrGap, e.Rev, s.Rev)
	}
	next := s
	next.Rev = e.Rev
	switch e.Type {
	case "agent":
		if e.Agent == nil {
			return s, errors.New("fleet: an agent event without its agent")
		}
		next.Workspaces = withAgent(s.Workspaces, e.WorkspaceID, *e.Agent)
	case "workspace":
		if e.Workspace == nil {
			return s, errors.New("fleet: a workspace event without its workspace")
		}
		next.Workspaces = withWorkspace(s.Workspaces, *e.Workspace)
	case "workspace-gone":
		next.Workspaces = slices.DeleteFunc(slices.Clone(s.Workspaces), func(w Workspace) bool { return w.ID == e.WorkspaceID })
	case "focus":
		next.FocusedWorkspaceID = e.WorkspaceID
	}
	return next, nil
}

func withAgent(spaces []Workspace, workspaceID string, agent Agent) []Workspace {
	out := slices.Clone(spaces)
	for i, w := range out {
		if w.ID != workspaceID {
			continue
		}
		agents := slices.Clone(w.Agents)
		if j := slices.IndexFunc(agents, func(a Agent) bool { return a.ID == agent.ID }); j >= 0 {
			agents[j] = agent
		} else {
			agents = append(agents, agent)
		}
		out[i].Agents = agents
	}
	return out
}

func withWorkspace(spaces []Workspace, w Workspace) []Workspace {
	out := slices.Clone(spaces)
	if i := slices.IndexFunc(out, func(x Workspace) bool { return x.ID == w.ID }); i >= 0 {
		out[i] = w
		return out
	}
	return append(out, w)
}

// decode reads one frame's data.
func decode(data string) (Event, error) {
	var e Event
	if err := json.Unmarshal([]byte(data), &e); err != nil {
		return Event{}, fmt.Errorf("fleet: a frame that is not an event: %w", err)
	}
	return e, nil
}
