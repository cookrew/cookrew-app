package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// rawServer records each /raw body; answer picks each one's status.
type rawServer struct {
	mu     sync.Mutex
	bodies []struct{ Data, ID string }
	answer func(n int) int
	gate   chan struct{} // when set, the first request waits for it
}

func (s *rawServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct{ Data, ID string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	s.bodies = append(s.bodies, body)
	n := len(s.bodies)
	gate := s.gate
	s.mu.Unlock()
	if n == 1 && gate != nil {
		<-gate
	}
	status := http.StatusOK
	if s.answer != nil {
		status = s.answer(n)
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (s *rawServer) got() []struct{ Data, ID string } {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]struct{ Data, ID string }(nil), s.bodies...)
}

func typistOn(t *testing.T, s *rawServer) (*typist, *[]string) {
	t.Helper()
	server := httptest.NewServer(s)
	t.Cleanup(server.Close)
	p, err := plane.NewLoopback(server.URL, plane.StaticCredentials("", "tok"), nil)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	said := []string{}
	ty := newTypist(p, "t1", func(msg string, _ bool) {
		mu.Lock()
		said = append(said, msg)
		mu.Unlock()
	})
	t.Cleanup(ty.stop)
	return ty, &said
}

func eventually(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestKeysTypedWhileOneBatchIsOutGoTogetherInOrder(t *testing.T) {
	s := &rawServer{gate: make(chan struct{})}
	ty, _ := typistOn(t, s)
	ty.typeBytes([]byte("a"))
	eventually(t, func() bool { return len(s.got()) == 1 })
	for _, k := range []string{"b", "c", "\r"} {
		ty.typeBytes([]byte(k))
	}
	close(s.gate)
	eventually(t, func() bool { return len(s.got()) == 2 })
	got := s.got()
	if got[0].Data != "a" || got[1].Data != "bc\r" {
		t.Fatalf("batches %+v", got)
	}
	if got[0].ID == got[1].ID || !strings.HasPrefix(got[0].ID, "desk-") {
		t.Errorf("batch ids %q %q", got[0].ID, got[1].ID)
	}
}

func TestALostAnswerIsSentAgainUnderTheSameBatch(t *testing.T) {
	s := &rawServer{answer: func(n int) int {
		if n == 1 {
			return http.StatusBadGateway
		}
		return http.StatusOK
	}}
	ty, _ := typistOn(t, s)
	ty.typeBytes([]byte("ls\r"))
	eventually(t, func() bool { return len(s.got()) == 2 })
	got := s.got()
	if got[0].ID != got[1].ID || got[1].Data != "ls\r" {
		t.Fatalf("retry %+v: want the same batch id", got)
	}
}

func TestAHeldBatchIsNotSentAgainAndIsSaid(t *testing.T) {
	s := &rawServer{answer: func(int) int { return http.StatusConflict }}
	ty, said := typistOn(t, s)
	ty.typeBytes([]byte("x"))
	eventually(t, func() bool {
		ty.mu.Lock()
		defer ty.mu.Unlock()
		return !ty.running
	})
	if n := len(s.got()); n != 1 {
		t.Errorf("%d sends: a 409 is an answer, not a loss", n)
	}
	if len(*said) == 0 || !strings.HasPrefix((*said)[len(*said)-1], "not typed") {
		t.Errorf("said %q", *said)
	}
}

func TestKeysAfterAGiveUpWaitForTheUser(t *testing.T) {
	s := &rawServer{answer: func(n int) int {
		if n == 1 {
			return http.StatusConflict
		}
		return http.StatusOK
	}}
	ty, _ := typistOn(t, s)
	ty.typeBytes([]byte("fix the bug"))
	eventually(t, func() bool { ty.mu.Lock(); defer ty.mu.Unlock(); return ty.held })
	ty.typeBytes([]byte("\r")) // a Return alone would submit whatever the box holds
	time.Sleep(50 * time.Millisecond)
	if n := len(s.got()); n != 1 {
		t.Fatalf("%d sends: keys after a give-up went out", n)
	}
	ty.resume()
	ty.typeBytes([]byte("again\r"))
	eventually(t, func() bool { return len(s.got()) == 2 })
	if got := s.got()[1].Data; got != "again\r" {
		t.Errorf("after resume sent %q", got)
	}
}

func TestKeysTypedBeforeStopStillGoOut(t *testing.T) {
	s := &rawServer{gate: make(chan struct{})}
	ty, _ := typistOn(t, s)
	ty.typeBytes([]byte("a"))
	eventually(t, func() bool { return len(s.got()) == 1 })
	ty.typeBytes([]byte("b\r"))
	ty.stop() // the screen goes while a batch is out and one waits
	close(s.gate)
	eventually(t, func() bool { return len(s.got()) == 2 })
	if got := s.got()[1].Data; got != "b\r" {
		t.Errorf("sent %q", got)
	}
}

func TestNothingIsSentAfterStop(t *testing.T) {
	s := &rawServer{}
	ty, _ := typistOn(t, s)
	ty.stop()
	ty.typeBytes([]byte("x"))
	time.Sleep(50 * time.Millisecond)
	if n := len(s.got()); n != 0 {
		t.Errorf("%d sends after stop", n)
	}
}
