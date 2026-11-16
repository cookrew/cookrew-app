package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/api"
	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// typist types what the user typed into one terminal, in order: one /raw at a
// time, what came meanwhile joined into the next. Each batch has an id, so
// one sent again after a lost answer is typed once (once-by-key.ts).
//
// A batch it gives up on (refused, or lost three times) holds the keys
// after it until the user says to go on: a Return that went out alone would
// submit whatever the agent's box held, which the user never typed.
type typist struct {
	plane  plane.Plane
	id     string
	prefix string
	// say tells the screen what to show: a message, and whether typing is held.
	say func(msg string, held bool)

	mu      sync.Mutex
	pending []byte
	running bool
	held    bool
	stopped bool
	seq     int
}

// tries is how often one batch is sent before it is given up.
const tries = 3

func newTypist(p plane.Plane, id string, say func(msg string, held bool)) *typist {
	return &typist{plane: p, id: id, prefix: randomPrefix(), say: say}
}

func randomPrefix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "desk-" + hex.EncodeToString(b)
}

// typeBytes queues what the user typed. Called on the main thread.
func (t *typist) typeBytes(data []byte) {
	if len(data) == 0 {
		return
	}
	t.mu.Lock()
	if t.stopped || t.held {
		held := t.held
		t.mu.Unlock()
		if held {
			t.say("typing is held: press Type again first", true)
		}
		return
	}
	t.pending = append(t.pending, data...)
	start := !t.running
	t.running = true
	t.mu.Unlock()
	if start {
		go t.run()
	}
}

// resume lets keys through again after a give-up.
func (t *typist) resume() {
	t.mu.Lock()
	t.held = false
	t.mu.Unlock()
	t.say("", false)
}

// stop takes no more keys. Keys already typed still go out: the user typed them.
func (t *typist) stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
}

func (t *typist) run() {
	for {
		t.mu.Lock()
		if len(t.pending) == 0 || t.held {
			t.running = false
			t.mu.Unlock()
			return
		}
		batch := t.pending
		t.pending = nil
		t.seq++
		key := fmt.Sprintf("%s-%d", t.prefix, t.seq)
		t.mu.Unlock()
		if err := t.send(string(batch), key); err != nil {
			t.mu.Lock()
			t.pending = nil
			t.held = true
			t.mu.Unlock()
			t.say("not typed: "+err.Error(), true)
		}
	}
}

// send sends one batch, again under the same key after a lost answer.
func (t *typist) send(data, key string) error {
	var err error
	for try := range tries {
		if try > 0 {
			time.Sleep(time.Duration(try) * 300 * time.Millisecond)
		}
		err = api.Raw(context.Background(), t.plane, t.id, data, key)
		if err == nil {
			return nil
		}
		if errors.Is(err, api.ErrHeld) || errors.Is(err, plane.ErrRefused) {
			return err // a refusal is an answer: sending it again would not change it
		}
	}
	return err
}
