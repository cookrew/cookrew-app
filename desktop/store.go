package main

import (
	"context"
	"slices"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/api"
	"github.com/cookrew/cookrew-app/phone/core/fleet"
	"github.com/cookrew/cookrew-app/phone/core/plane"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// Store is what the app knows of the machine, as signals. Written on the
// main thread only: the goroutines that follow the machine post to it.
type Store struct {
	plane plane.Plane
	// Fleet is the machine's fleet as the feed last said.
	Fleet *signal.Signal[fleet.Snapshot]
	// Roster is every agent the machine knows, by id (preset, folder).
	Roster *signal.Signal[map[string]api.Entry]
	// Link is how the feed stands: "" while it is up, else why it is not.
	Link *signal.Signal[string]
	// Loaded is true once a first snapshot arrived.
	Loaded *signal.Signal[bool]
}

// NewStore starts following the machine; stop ends it.
func NewStore(p plane.Plane) (store *Store, stop func()) {
	s := &Store{
		plane:  p,
		Fleet:  signal.NewFunc(fleet.Snapshot{}, nil),
		Roster: signal.NewFunc(map[string]api.Entry{}, nil),
		Link:   signal.New("connecting"),
		Loaded: signal.New(false),
	}
	ctx, cancel := context.WithCancel(context.Background())
	go s.follow(ctx)
	return s, cancel
}

// rosterEvery bounds how often a new agent makes the roster be read again.
const rosterEvery = 10 * time.Second

func (s *Store) follow(ctx context.Context) {
	seen := map[string]bool{} // agents the roster was read with (this goroutine only)
	var lastRoster time.Time
	err := fleet.Follower{}.Follow(ctx, s.plane, func(snap fleet.Snapshot) {
		if newAgents(snap, seen) && time.Since(lastRoster) > rosterEvery {
			lastRoster = time.Now()
			go s.loadRoster(ctx)
		}
		ui.Post(func() {
			s.Fleet.Set(snap)
			s.Loaded.Set(true)
			s.Link.Set("")
		})
	}, func(err error) {
		clear(seen) // the stream comes back with a snapshot: read the roster again then
		lastRoster = time.Time{}
		ui.Post(func() { s.Link.Set(err.Error()) })
	})
	if ctx.Err() == nil && err != nil {
		ui.Post(func() { s.Link.Set(err.Error()) })
	}
}

// newAgents notes snap's agents in seen, and reports whether any was new.
func newAgents(snap fleet.Snapshot, seen map[string]bool) bool {
	found := false
	for _, w := range snap.Workspaces {
		for _, a := range w.Agents {
			if !seen[a.ID] {
				seen[a.ID] = true
				found = true
			}
		}
	}
	return found
}

func (s *Store) loadRoster(ctx context.Context) {
	entries, err := api.Agents(ctx, s.plane)
	if err != nil {
		return // the cards show without a folder; the next reconnect asks again
	}
	byID := make(map[string]api.Entry, len(entries))
	for _, e := range entries {
		byID[e.ID] = e
	}
	ui.Post(func() { s.Roster.Set(byID) })
}

// WorkspaceIDs follows the workspaces' ids, in the feed's order: it changes
// only when one comes or goes, not when an agent's phase does.
func (s *Store) WorkspaceIDs() signal.Accessor[[]string] {
	return signal.NewMemoFunc(func() []string {
		spaces := s.Fleet.Get().Workspaces
		ids := make([]string, len(spaces))
		for i, w := range spaces {
			ids[i] = w.ID
		}
		return ids
	}, slices.Equal[[]string])
}

// Workspace follows one workspace (the zero one once it is gone).
func (s *Store) Workspace(id string) signal.Accessor[fleet.Workspace] {
	return signal.Func(func() fleet.Workspace {
		for _, w := range s.Fleet.Get().Workspaces {
			if w.ID == id {
				return w
			}
		}
		return fleet.Workspace{}
	})
}

// Agents follows one workspace's agents, changing only when one does.
func (s *Store) Agents(workspaceID string) signal.Accessor[[]fleet.Agent] {
	workspace := s.Workspace(workspaceID)
	return signal.NewMemoFunc(func() []fleet.Agent { return workspace.Get().Agents }, slices.Equal[[]fleet.Agent])
}

// Agent follows one agent wherever it sits (ok false once it is gone).
func (s *Store) Agent(id string) signal.Accessor[fleet.Agent] {
	return signal.NewMemoFunc(func() fleet.Agent {
		for _, w := range s.Fleet.Get().Workspaces {
			for _, a := range w.Agents {
				if a.ID == id {
					return a
				}
			}
		}
		return fleet.Agent{ID: id, Phase: "offline"}
	}, func(a, b fleet.Agent) bool { return a == b })
}
