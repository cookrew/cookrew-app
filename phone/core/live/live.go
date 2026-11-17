// Package live follows a machine's terminal stream into a screen
// (GET /api/terminal/<id>/stream, src/main/mobile-api.ts):
//
//   - a `hello` frame comes first: the pane's grid, which the screen takes
//     before any byte, or the pane's absolute-addressed deltas land in the
//     wrong cells;
//   - then `data` frames, each a JSON string of the pane's bytes; the first is
//     a whole repaint (it starts by clearing the screen);
//   - a `hello` with resized:true says another viewer resized the shared
//     pane: the screen takes the new grid, and the whole frame that follows
//     is applied as it is, never merged with what the screen had;
//   - `exit` says the pane is gone: nothing to dial again.
//
// A stream that drops is opened again, as the renderer's live-stream.ts does:
// every open starts with hello and a whole frame, so the screen heals.
//
// The screen never asks the pane to change size: a viewer only follows.
package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/api"
	"github.com/cookrew/cookrew-app/phone/core/plane"
	"github.com/cookrew/cookrew-app/phone/core/sse"
)

// Screen is where a pane's stream lands.
type Screen interface {
	// Resize sets the grid to the pane's.
	Resize(cols, rows int) error
	// Feed hands over the pane's bytes, in order.
	Feed(data []byte) error
}

// Hello is the stream's grid frame.
type Hello struct {
	Cols    int    `json:"cols"`
	Rows    int    `json:"rows"`
	Stream  string `json:"stream"`
	Resized bool   `json:"resized"`
}

// maxGrid bounds a hello's grid: past it the frame is not a pane's.
const maxGrid = 2000

func (h Hello) valid() bool {
	return h.Cols > 0 && h.Rows > 0 && h.Cols <= maxGrid && h.Rows <= maxGrid
}

// Phase is where a follow stands.
type Phase int

const (
	// Connecting: the stream is being opened.
	Connecting Phase = iota
	// Live: a hello arrived; Status.Hello is the grid.
	Live
	// Retrying: the stream failed (Status.Err) and opens again after Status.Wait.
	Retrying
)

func (p Phase) String() string {
	return [...]string{"connecting", "live", "retrying"}[p]
}

// Status is what a viewer may show about the stream.
type Status struct {
	Phase Phase
	Hello Hello
	Err   error
	Wait  time.Duration
}

var (
	// ErrExited is the pane's own end: the follow is over.
	ErrExited = errors.New("live: the terminal exited")
	// ErrBadTerminal is a terminal id that is not one.
	ErrBadTerminal = errors.New("live: not a terminal id")
	// errNoHello is bytes before the grid: the stream is not followed.
	errNoHello  = errors.New("live: bytes came before the hello")
	errBadHello = errors.New("live: a hello frame that is not a grid")
)

// Backoff is the renderer's TERMINAL_STREAM_BACKOFF.
var Backoff = []time.Duration{400 * time.Millisecond, 800 * time.Millisecond, 1500 * time.Millisecond, 3 * time.Second, 5 * time.Second}

// Follower follows terminal streams.
type Follower struct {
	// Backoff is the wait before each reopen, its last repeated; nil: Backoff.
	Backoff []time.Duration
	// Dead is the silence after which a stream is dropped; 0: sse.DeadAfter.
	Dead time.Duration
}

// Follow applies terminal id's stream to screen until ctx ends (its error),
// the pane exits (ErrExited), or the machine refuses this device
// (plane.ErrRefused, plane.ErrSessionEnded). Anything else opens the stream
// again. report, if not nil, hears each change of Status on Follow's goroutine.
func (f Follower) Follow(ctx context.Context, p plane.Plane, id string, screen Screen, report func(Status)) error {
	if !api.IsTerminalID(id) {
		return fmt.Errorf("%w: %q", ErrBadTerminal, id)
	}
	if report == nil {
		report = func(Status) {}
	}
	route := "/api/terminal/" + id + "/stream"
	failures := 0
	for {
		report(Status{Phase: Connecting})
		greeted, err := f.once(ctx, p, route, screen, report)
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case errors.Is(err, ErrExited), errors.Is(err, plane.ErrRefused), errors.Is(err, plane.ErrSessionEnded):
			return err
		}
		if greeted {
			failures = 0 // it was up: start the backoff over
		}
		wait := f.wait(failures)
		failures++
		report(Status{Phase: Retrying, Err: err, Wait: wait})
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// once follows one open of the stream. greeted says a hello arrived.
func (f Follower) once(ctx context.Context, p plane.Plane, route string, screen Screen, report func(Status)) (greeted bool, err error) {
	resp, err := p.Do(ctx, plane.Request{Route: route, Stream: true})
	if err != nil {
		return false, err
	}
	dead := f.Dead
	if dead == 0 {
		dead = sse.DeadAfter
	}
	err = sse.Watch(ctx, resp.Body, dead, func(e sse.Event) error {
		switch e.Type {
		case "hello":
			var h Hello
			if json.Unmarshal([]byte(e.Data), &h) != nil || !h.valid() {
				return fmt.Errorf("%w: %.80s", errBadHello, e.Data)
			}
			if err := screen.Resize(h.Cols, h.Rows); err != nil {
				return err
			}
			greeted = true
			report(Status{Phase: Live, Hello: h})
		case "data":
			if !greeted {
				return errNoHello
			}
			var chunk string
			if err := json.Unmarshal([]byte(e.Data), &chunk); err != nil {
				return fmt.Errorf("live: a data frame that is not a string: %w", err)
			}
			return screen.Feed([]byte(chunk))
		case "exit":
			return ErrExited
		}
		return nil
	})
	if err == nil {
		err = errors.New("live: the stream ended")
	}
	return greeted, err
}

func (f Follower) wait(failures int) time.Duration {
	steps := f.Backoff
	if len(steps) == 0 {
		steps = Backoff
	}
	return steps[min(failures, len(steps)-1)]
}
