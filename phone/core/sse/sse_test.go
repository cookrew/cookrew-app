package sse

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func collect(t *testing.T, stream string) []Event {
	t.Helper()
	var got []Event
	err := Read(strings.NewReader(stream), func(e Event) error {
		got = append(got, e)
		return nil
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Read ended with %v, want EOF", err)
	}
	return got
}

func TestReadsTheMachinesFrames(t *testing.T) {
	// What startSse writes: a comment, a heartbeat, an event, and the relay's bare newline keepalive.
	stream := ":ok\n\nevent: hb\ndata: 1\n\nevent: agent\ndata: {\"id\":\"a1\"}\n\n\n\nevent: workspaces\r\ndata: [1,\r\ndata: 2]\r\nid: 7\r\n\r\n"
	want := []Event{
		{Type: "hb", Data: "1"},
		{Type: "agent", Data: `{"id":"a1"}`},
		{Type: "workspaces", Data: "[1,\n2]", ID: "7"},
	}
	if got := collect(t, stream); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

func TestAFrameWithNoEventIsAMessageAndNoDataIsNothing(t *testing.T) {
	got := collect(t, "event: lonely\n\ndata:x\n\n")
	want := []Event{{Type: "message", Data: "x"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v want %#v", got, want)
	}
}

func TestALongReplayFrameSurvives(t *testing.T) {
	big := strings.Repeat("\\u001b[0m", 300_000) // ~3 MB on one data line, as a terminal replay is
	got := collect(t, "event: data\ndata: \""+big+"\"\n\n")
	if len(got) != 1 || len(got[0].Data) != len(big)+2 {
		t.Fatalf("got %d events, data %d bytes", len(got), len(got[0].Data))
	}
}

func TestALineOverTheLimitEndsTheStream(t *testing.T) {
	err := Read(strings.NewReader("data: "+strings.Repeat("x", MaxLine+1)+"\n\n"), func(Event) error { return nil })
	if !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("got %v, want ErrLineTooLong", err)
	}
}

func TestEmitErrorStopsReading(t *testing.T) {
	stop := errors.New("stop")
	err := Read(strings.NewReader("data: 1\n\ndata: 2\n\n"), func(Event) error { return stop })
	if !errors.Is(err, stop) {
		t.Fatalf("got %v", err)
	}
}

func TestWatchCallsASilentStreamDead(t *testing.T) {
	reader, writer := io.Pipe()
	go func() { _, _ = writer.Write([]byte("event: hb\ndata: 1\n\n")) }()
	start := time.Now()
	err := Watch(context.Background(), reader, 80*time.Millisecond, func(Event) error {
		t.Error("a heartbeat reached emit")
		return nil
	})
	if !errors.Is(err, ErrSilent) {
		t.Fatalf("got %v, want ErrSilent", err)
	}
	if time.Since(start) < 80*time.Millisecond {
		t.Fatal("declared dead before the window")
	}
}

func TestWatchKeepsALiveStreamAndHandsOverEvents(t *testing.T) {
	reader, writer := io.Pipe()
	go func() {
		for i := 0; i < 4; i++ {
			_, _ = writer.Write([]byte("event: hb\ndata: 1\n\n"))
			time.Sleep(20 * time.Millisecond)
		}
		_, _ = writer.Write([]byte("event: agent\ndata: {}\n\n"))
		_ = writer.Close()
	}()
	var got []Event
	err := Watch(context.Background(), reader, 250*time.Millisecond, func(e Event) error {
		got = append(got, e)
		return nil
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("got %v, want EOF (heartbeats every 20ms should keep a 250ms window alive)", err)
	}
	if len(got) != 1 || got[0].Type != "agent" {
		t.Fatalf("got %#v", got)
	}
}

func TestTheLastEventIDCarriesOver(t *testing.T) {
	got := collect(t, "id: 4\ndata: a\n\ndata: b\n\n")
	if len(got) != 2 || got[0].ID != "4" || got[1].ID != "4" {
		t.Fatalf("got %#v", got)
	}
}

// Bytes of a long frame trickling in are life, even with no event dispatched yet.
func TestWatchCountsBytesOfALongFrameAsLife(t *testing.T) {
	reader, writer := io.Pipe()
	go func() {
		_, _ = writer.Write([]byte("event: data\ndata: \""))
		for i := 0; i < 10; i++ {
			time.Sleep(20 * time.Millisecond)
			_, _ = writer.Write([]byte("xxxxxxxx"))
		}
		_, _ = writer.Write([]byte("\"\n\n"))
		_ = writer.Close()
	}()
	var got []Event
	err := Watch(context.Background(), reader, 120*time.Millisecond, func(e Event) error {
		got = append(got, e)
		return nil
	})
	if !errors.Is(err, io.EOF) || len(got) != 1 {
		t.Fatalf("a frame arriving over 200ms in 20ms pieces died in a 120ms window: %v, %d events", err, len(got))
	}
}

// Nothing reaches emit once Watch has returned, however much was still buffered.
func TestWatchEmitsNothingAfterItReturns(t *testing.T) {
	var frames strings.Builder
	for i := 0; i < 500; i++ {
		frames.WriteString("event: agent\ndata: {}\n\n")
	}
	reader, writer := io.Pipe()
	go func() { _, _ = writer.Write([]byte(frames.String())) }() // one write: ~490 frames sit in the buffer at cancel
	ctx, cancel := context.WithCancel(context.Background())
	var returned atomic.Bool
	var late, count atomic.Int32
	err := Watch(ctx, reader, time.Second, func(Event) error {
		if returned.Load() {
			late.Add(1)
		}
		if count.Add(1) == 10 {
			cancel()
			time.Sleep(5 * time.Millisecond) // let the loop see ctx before the next event
		}
		return nil
	})
	returned.Store(true)
	time.Sleep(50 * time.Millisecond)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
	if n := late.Load(); n != 0 {
		t.Fatalf("%d events reached emit after Watch returned", n)
	}
}
