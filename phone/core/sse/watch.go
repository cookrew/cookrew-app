package sse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)

// ErrSilent is returned when no byte arrived for the dead window: not a
// heartbeat, not a piece of a long frame.
var ErrSilent = errors.New("sse: the stream went silent")

// errStopped ends the reader once Watch has returned.
var errStopped = errors.New("sse: stopped")

// Watch reads like Read, but also ends with ErrSilent when no byte arrives for
// `dead`. Every byte counts as life, so a long replay frame on a slow road is
// not mistaken for a dead one. Heartbeats are not handed to emit.
//
// emit runs on the caller's goroutine, never after Watch returns. The body is
// closed and the reader goroutine has ended by the time Watch returns.
func Watch(ctx context.Context, body io.ReadCloser, dead time.Duration, emit func(Event) error) error {
	alive := make(chan struct{}, 1)
	events := make(chan Event)
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Read(livenessReader{r: body, alive: alive}, func(e Event) error {
			select {
			case events <- e:
				return nil
			case <-stop:
				return errStopped
			}
		})
	}()
	err, readerEnded := loop(ctx, dead, alive, events, done, emit)
	close(stop)
	_ = body.Close()
	if !readerEnded {
		<-done // a closed body or a closed stop ends it
	}
	return err
}

// loop runs until the reader ends, emit fails, the stream is silent or ctx
// ends. readerEnded reports whether the reader's own end was the reason.
func loop(ctx context.Context, dead time.Duration, alive <-chan struct{}, events <-chan Event, done <-chan error, emit func(Event) error) (err error, readerEnded bool) {
	timer := time.NewTimer(dead)
	defer timer.Stop()
	for {
		select {
		case err := <-done:
			return err, true
		case e := <-events:
			if e.Type == Heartbeat {
				continue
			}
			if err := emit(e); err != nil {
				return err, false
			}
		case <-alive:
			timer.Reset(dead)
		case <-timer.C:
			return fmt.Errorf("%w for %s", ErrSilent, dead), false
		case <-ctx.Done():
			return ctx.Err(), false
		}
	}
}

// livenessReader signals alive on every read that brought bytes.
type livenessReader struct {
	r     io.Reader
	alive chan<- struct{}
}

func (l livenessReader) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if n > 0 {
		select {
		case l.alive <- struct{}{}:
		default:
		}
	}
	return n, err
}
