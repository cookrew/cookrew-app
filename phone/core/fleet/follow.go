package fleet

import (
	"context"
	"errors"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/plane"
	"github.com/cookrew/cookrew-app/phone/core/sse"
)

// Follower follows a machine's fleet feed.
type Follower struct {
	// Backoff is the wait before each reopen, its last repeated; nil: one
	// second, then two, then five.
	Backoff []time.Duration
	// Dead is the silence after which the stream is dropped; 0: sse.DeadAfter.
	// The feed sends a ':' line every 15 s, which counts as life.
	Dead time.Duration
}

var defaultBackoff = []time.Duration{time.Second, 2 * time.Second, 5 * time.Second}

// Follow hands each state of the fleet to onState, on Follow's goroutine,
// until ctx ends (its error) or the machine refuses this device. onError, if
// not nil, hears why a stream ended before it is opened again.
func (f Follower) Follow(ctx context.Context, p plane.Plane, onState func(Snapshot), onError func(error)) error {
	failures := 0
	for {
		got, err := f.once(ctx, p, onState)
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case errors.Is(err, plane.ErrRefused), errors.Is(err, plane.ErrSessionEnded):
			return err
		}
		if onError != nil {
			onError(err)
		}
		if got {
			failures = 0
		}
		steps := f.Backoff
		if len(steps) == 0 {
			steps = defaultBackoff
		}
		timer := time.NewTimer(steps[min(failures, len(steps)-1)])
		failures++
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// once follows one open; got says a snapshot arrived.
func (f Follower) once(ctx context.Context, p plane.Plane, onState func(Snapshot)) (got bool, err error) {
	resp, err := p.Do(ctx, plane.Request{Route: "/api/fleet/stream", Stream: true})
	if err != nil {
		return false, err
	}
	dead := f.Dead
	if dead == 0 {
		dead = sse.DeadAfter
	}
	var state Snapshot
	err = sse.Watch(ctx, resp.Body, dead, func(e sse.Event) error {
		event, err := decode(e.Data)
		if err != nil {
			return err
		}
		next, err := Apply(state, event)
		if err != nil {
			return err
		}
		state = next
		got = true
		onState(state)
		return nil
	})
	if err == nil {
		err = errors.New("fleet: the stream ended")
	}
	return got, err
}
