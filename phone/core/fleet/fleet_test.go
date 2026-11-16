package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

const snapshotJSON = `{"type":"snapshot","snapshot":{"v":1,"rev":7,"at":1,"machine":{"name":"Mac","appVersion":"0.6.10","profile":{"kind":"laptop"}},
"focusedWorkspaceId":"w1","workspaces":[
 {"id":"w1","name":"Dev","icon":"🗂","state":"focused","agents":[
   {"id":"a1","name":"Conductor","harness":"claude","model":"opus","orch":true,"phase":"thinking","phaseSource":"live","phaseSince":5,"task":"ship","reply":null,"status":"Cerebrating…","turns":3,"attachments":[]}],
  "loose":[],"counts":{"agents":1,"notes":0,"browsers":0}},
 {"id":"w2","name":"Home","icon":null,"state":"background","agents":[],"loose":[],"counts":{"agents":0,"notes":0,"browsers":0}}]}}`

func event(t *testing.T, raw string) Event {
	t.Helper()
	var e Event
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		t.Fatalf("decoding %s: %v", raw, err)
	}
	return e
}

func start(t *testing.T) Snapshot {
	t.Helper()
	s, err := Apply(Snapshot{}, event(t, snapshotJSON))
	if err != nil {
		t.Fatalf("Apply snapshot: %v", err)
	}
	return s
}

func TestASnapshotIsTheWholeFleet(t *testing.T) {
	s := start(t)
	if s.Rev != 7 || s.Machine.Name != "Mac" || len(s.Workspaces) != 2 || s.FocusedWorkspaceID != "w1" {
		t.Fatalf("snapshot %+v", s)
	}
	a := s.Workspaces[0].Agents[0]
	if a.Phase != "thinking" || a.Status != "Cerebrating…" || a.Task != "ship" || a.Reply != "" || !a.Orch {
		t.Errorf("agent %+v", a)
	}
}

func TestAnAgentEventReplacesOneAgentAndLeavesTheOldSnapshotAlone(t *testing.T) {
	before := start(t)
	after, err := Apply(before, event(t, `{"type":"agent","rev":8,"workspaceId":"w1","agent":{"id":"a1","name":"Conductor","harness":"claude","phase":"waiting","phaseSource":"live","turns":4,"attachments":[]}}`))
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if after.Rev != 8 || after.Workspaces[0].Agents[0].Phase != "waiting" {
		t.Errorf("after %+v", after.Workspaces[0].Agents[0])
	}
	if before.Rev != 7 || before.Workspaces[0].Agents[0].Phase != "thinking" {
		t.Error("Apply changed the snapshot it was given")
	}
}

func TestWorkspaceEvents(t *testing.T) {
	s := start(t)
	s, err := Apply(s, event(t, `{"type":"workspace","rev":8,"workspace":{"id":"w3","name":"New","state":"background","agents":[],"loose":[],"counts":{"agents":0,"notes":0,"browsers":0}}}`))
	if err != nil || len(s.Workspaces) != 3 || s.Workspaces[2].Name != "New" {
		t.Fatalf("added: %v %+v", err, s.Workspaces)
	}
	s, err = Apply(s, event(t, `{"type":"workspace","rev":9,"workspace":{"id":"w1","name":"Renamed","state":"focused","agents":[],"loose":[],"counts":{"agents":0,"notes":0,"browsers":0}}}`))
	if err != nil || s.Workspaces[0].Name != "Renamed" || len(s.Workspaces) != 3 {
		t.Fatalf("replaced in place: %v %+v", err, s.Workspaces)
	}
	s, err = Apply(s, event(t, `{"type":"workspace-gone","rev":10,"workspaceId":"w2"}`))
	if err != nil || len(s.Workspaces) != 2 || s.Workspaces[1].ID != "w3" {
		t.Fatalf("gone: %v %+v", err, s.Workspaces)
	}
	s, err = Apply(s, event(t, `{"type":"focus","rev":11,"workspaceId":"w3"}`))
	if err != nil || s.FocusedWorkspaceID != "w3" {
		t.Fatalf("focus: %v %q", err, s.FocusedWorkspaceID)
	}
}

func TestARevGapIsAnError(t *testing.T) {
	s := start(t)
	if _, err := Apply(s, event(t, `{"type":"focus","rev":9,"workspaceId":"w2"}`)); !errors.Is(err, ErrGap) {
		t.Fatalf("got %v, want ErrGap", err)
	}
	if _, err := Apply(Snapshot{}, event(t, `{"type":"focus","rev":1,"workspaceId":"w2"}`)); !errors.Is(err, ErrGap) {
		t.Fatalf("a delta before any snapshot: %v", err)
	}
}

func TestAnUnknownEventKeepsTheRevGoing(t *testing.T) {
	s := start(t)
	s, err := Apply(s, event(t, `{"type":"something-newer","rev":8}`))
	if err != nil || s.Rev != 8 {
		t.Fatalf("got %v rev %d", err, s.Rev)
	}
}

func TestFollowReopensOnAGapAndHandsOverEachState(t *testing.T) {
	var mu sync.Mutex
	opens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/fleet/stream" {
			t.Errorf("path %s", r.URL.Path)
		}
		mu.Lock()
		opens++
		n := opens
		mu.Unlock()
		_, _ = io.WriteString(w, ":ok\n\ndata: "+compact(snapshotJSON)+"\n\n")
		if n == 1 {
			_, _ = io.WriteString(w, ":\n\ndata: {\"type\":\"focus\",\"rev\":12,\"workspaceId\":\"w2\"}\n\n")
			return
		}
		_, _ = io.WriteString(w, "data: {\"type\":\"focus\",\"rev\":8,\"workspaceId\":\"w2\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	p, _ := plane.NewLoopback(server.URL, plane.StaticCredentials("", "t"), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var got []Snapshot
	err := Follower{Backoff: []time.Duration{time.Millisecond}}.Follow(ctx, p, func(s Snapshot) {
		got = append(got, s)
		if s.Rev == 8 {
			cancel()
		}
	}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Follow: %v", err)
	}
	// open 1: snapshot (7); the gap drops it. open 2: snapshot (7), focus (8).
	if len(got) != 3 || got[2].FocusedWorkspaceID != "w2" || opens != 2 {
		t.Fatalf("%d states over %d opens: %+v", len(got), opens, got)
	}
}

func compact(raw string) string {
	var v any
	_ = json.Unmarshal([]byte(raw), &v)
	out, _ := json.Marshal(v)
	return string(out)
}
