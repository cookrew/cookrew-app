package live

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// screen records what a stream did to it, in order.
type screen struct {
	mu  sync.Mutex
	ops []string
}

func (s *screen) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, fmt.Sprintf("resize %dx%d", cols, rows))
	return nil
}

func (s *screen) Feed(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ops = append(s.ops, "feed "+string(data))
	return nil
}

func (s *screen) got() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.ops...)
}

func frame(event, data string) string { return "event: " + event + "\ndata: " + data + "\n\n" }

// fast is a follower that does not make a test wait.
func fast() Follower {
	return Follower{Backoff: []time.Duration{time.Millisecond}, Dead: time.Second}
}

func loopback(t *testing.T, url string) plane.Plane {
	t.Helper()
	p, err := plane.NewLoopback(url, plane.StaticCredentials("", "tok"), nil)
	if err != nil {
		t.Fatalf("NewLoopback: %v", err)
	}
	return p
}

func TestHelloSizesTheScreenBeforeAnyByte(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/terminal/t-1/stream" || r.Header.Get("Accept") != "text/event-stream" {
			t.Errorf("asked %s (Accept %q)", r.URL.Path, r.Header.Get("Accept"))
		}
		_, _ = io.WriteString(w, ":ok\n\n"+
			frame("hello", `{"cols":100,"rows":30,"stream":"s1"}`)+
			frame("data", `"\u001b[2Jframe"`)+
			frame("hb", `{}`)+
			frame("data", `"delta"`)+
			frame("exit", `{}`))
	}))
	defer server.Close()
	s := &screen{}
	err := fast().Follow(context.Background(), loopback(t, server.URL), "t-1", s, nil)
	if !errors.Is(err, ErrExited) {
		t.Fatalf("Follow: %v, want ErrExited", err)
	}
	want := []string{"resize 100x30", "feed \x1b[2Jframe", "feed delta"}
	if got := s.got(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestAResizedHelloIsFollowedByAWholeFrameAsIs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, frame("hello", `{"cols":80,"rows":24,"stream":"s"}`)+
			frame("data", `"a"`)+
			frame("hello", `{"cols":120,"rows":40,"stream":"s","resized":true}`)+
			frame("data", `"whole"`)+
			frame("exit", `{}`))
	}))
	defer server.Close()
	s := &screen{}
	var hellos []Hello
	report := func(st Status) {
		if st.Phase == Live {
			hellos = append(hellos, st.Hello)
		}
	}
	_ = fast().Follow(context.Background(), loopback(t, server.URL), "t", s, report)
	want := "resize 80x24|feed a|resize 120x40|feed whole"
	if got := strings.Join(s.got(), "|"); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if len(hellos) != 2 || !hellos[1].Resized || hellos[1].Cols != 120 {
		t.Errorf("reported hellos %+v", hellos)
	}
}

func TestADroppedStreamIsOpenedAgainAndPaintsWhole(t *testing.T) {
	var mu sync.Mutex
	opens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		opens++
		n := opens
		mu.Unlock()
		switch n {
		case 1: // the road drops mid-stream
			_, _ = io.WriteString(w, frame("hello", `{"cols":80,"rows":24,"stream":"a"}`)+frame("data", `"one"`))
		case 2: // the mirror is still booting
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":"Terminal not running"}`)
		default:
			_, _ = io.WriteString(w, frame("hello", `{"cols":80,"rows":24,"stream":"b"}`)+frame("data", `"two"`)+frame("exit", `{}`))
		}
	}))
	defer server.Close()
	s := &screen{}
	var phases []Phase
	err := fast().Follow(context.Background(), loopback(t, server.URL), "t", s, func(st Status) { phases = append(phases, st.Phase) })
	if !errors.Is(err, ErrExited) {
		t.Fatalf("Follow: %v", err)
	}
	if want := "resize 80x24|feed one|resize 80x24|feed two"; strings.Join(s.got(), "|") != want {
		t.Errorf("got %q", s.got())
	}
	retried := 0
	for _, p := range phases {
		if p == Retrying {
			retried++
		}
	}
	if retried != 2 {
		t.Errorf("phases %v: want two retries (a drop, a 404)", phases)
	}
}

func TestARefusedTokenEndsTheFollow(t *testing.T) {
	opens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	err := fast().Follow(context.Background(), loopback(t, server.URL), "t", &screen{}, nil)
	if !errors.Is(err, plane.ErrRefused) {
		t.Fatalf("Follow: %v, want ErrRefused", err)
	}
	if opens != 1 {
		t.Errorf("%d opens: a refusal is not retried", opens)
	}
}

func TestBytesBeforeHelloAreNeverFed(t *testing.T) {
	opens := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opens++
		if opens == 1 {
			_, _ = io.WriteString(w, frame("data", `"early"`)+frame("hello", `{"cols":80,"rows":24}`))
			return
		}
		_, _ = io.WriteString(w, frame("exit", `{}`))
	}))
	defer server.Close()
	s := &screen{}
	_ = fast().Follow(context.Background(), loopback(t, server.URL), "t", s, nil)
	if got := s.got(); len(got) != 0 {
		t.Errorf("fed before a hello: %q", got)
	}
}

func TestABadHelloIsNotApplied(t *testing.T) {
	for _, hello := range []string{`{"cols":0,"rows":24}`, `{"cols":80,"rows":-1}`, `{"cols":100000,"rows":24}`, `not json`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, frame("hello", hello)+frame("data", `"x"`))
		}))
		s := &screen{}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_ = fast().Follow(ctx, loopback(t, server.URL), "t", s, nil)
		cancel()
		server.Close()
		if got := s.got(); len(got) != 0 {
			t.Errorf("hello %s: applied %q", hello, got)
		}
	}
}

func TestATerminalIDCannotClimbOutOfItsRoute(t *testing.T) {
	err := fast().Follow(context.Background(), loopback(t, "http://127.0.0.1:1"), "../../admin", &screen{}, nil)
	if !errors.Is(err, ErrBadTerminal) {
		t.Fatalf("got %v, want ErrBadTerminal", err)
	}
}

func TestFollowEndsWithItsContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, frame("hello", `{"cols":80,"rows":24}`))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- fast().Follow(ctx, loopback(t, server.URL), "t", &screen{}, nil) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Follow: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Follow outlived its context")
	}
}
