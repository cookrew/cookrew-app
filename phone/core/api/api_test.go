package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

func machine(t *testing.T, handler http.HandlerFunc) plane.Plane {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	p, err := plane.NewLoopback(server.URL, plane.StaticCredentials("", "tok"), nil)
	if err != nil {
		t.Fatalf("NewLoopback: %v", err)
	}
	return p
}

func TestAgentsReadsTheRoster(t *testing.T) {
	p := machine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/agents" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"agents":[{"id":"a1","name":"Conductor","preset":"Claude Code","command":"claude","role":null,"cwd":"/w","workspaceId":"w1","workspaceName":"Dev","orch":true,"sessionRef":"s","spawnedAt":1,"active":true,"updatedAt":2}]}`)
	})
	got, err := Agents(context.Background(), p)
	if err != nil {
		t.Fatalf("Agents: %v", err)
	}
	if len(got) != 1 || got[0].Preset != "Claude Code" || got[0].Cwd != "/w" || !got[0].Active || got[0].Role != "" {
		t.Errorf("got %+v", got)
	}
}

func TestRawSendsTheKeysWithTheirBatch(t *testing.T) {
	var body struct{ Data, ID string }
	p := machine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/terminal/t1/raw" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("%s %s %q", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	if err := Raw(context.Background(), p, "t1", "ls\r", "k-1"); err != nil {
		t.Fatalf("Raw: %v", err)
	}
	if body.Data != "ls\r" || body.ID != "k-1" {
		t.Errorf("sent %+v", body)
	}
}

func TestRawNamesAHeldBatch(t *testing.T) {
	p := machine(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"dispatch-in-flight"}`)
	})
	if err := Raw(context.Background(), p, "t1", "x", ""); !errors.Is(err, ErrHeld) {
		t.Fatalf("got %v, want ErrHeld", err)
	}
}

func TestRawRefusesABatchIDTheMachineWouldIgnore(t *testing.T) {
	p := machine(t, func(w http.ResponseWriter, r *http.Request) { t.Error("sent") })
	if err := Raw(context.Background(), p, "t1", "x", "has space"); err == nil {
		t.Fatal("accepted")
	}
}

func TestRawRefusesAnIDThatReshapesTheRoute(t *testing.T) {
	p := machine(t, func(w http.ResponseWriter, r *http.Request) { t.Error("sent") })
	for _, id := range []string{"x?", "a/b", "..", ""} {
		if err := Raw(context.Background(), p, id, "x", ""); err == nil {
			t.Errorf("%q accepted", id)
		}
	}
}
