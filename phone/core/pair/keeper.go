package pair

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/account"
)

// RenewAhead is how long before its end a session is renewed: a week, as a
// Mac and the watch do (src/shared/session-renew.ts).
const RenewAhead = 7 * 24 * time.Hour

// RenewRest is how long a failed renewal waits before trying again: the
// registry allows five a minute per device.
const RenewRest = time.Minute

// Keeper holds the phone's session and renews it on the device key a week
// before it ends. Never after: a session that has ended was ended by the clock
// or by the owner ("Not me", a revoke), and the key must not bring it back.
//
// THE SIGN-IN HAS AN END OF ITS OWN. The registry caps every renewed token at
// thirty days from the sign-in (v2-session-age.ts · tokenExpiry), so a renewal
// that comes back no later than the token it replaced is the cap: the keeper
// stops renewing (each renewal closes the token before it, and a request
// holding that one would fail) and Capped says so, for the app to ask for a
// new code before the day comes.
//
// Safe for concurrent use. One renewal at a time, and the lock is never held
// across the network: Current answers at once while a renewal is out.
type Keeper struct {
	registry Registry
	key      account.Key
	now      func() time.Time
	// keep stores a renewed session (the keychain on the phone).
	keep func(Session) error

	mu        sync.Mutex
	session   Session
	restUntil time.Time
	// renewing is closed when the renewal in flight ends; nil when none is.
	renewing chan struct{}
	// capped: the last renewal gave no more time; no more are asked for.
	capped bool
	// unanswered: the last renewal got no answer, so it may have closed the
	// held token and made one this phone never saw. Newer tries it once more.
	unanswered bool
	failing    bool
}

// NewKeeper keeps a session. now nil means the wall clock; keep nil stores nothing.
func NewKeeper(registry Registry, key account.Key, session Session, now func() time.Time, keep func(Session) error) *Keeper {
	if now == nil {
		now = time.Now
	}
	if keep == nil {
		keep = func(Session) error { return nil }
	}
	return &Keeper{registry: registry, key: key, session: session, now: now, keep: keep}
}

// Current is the session as held, with no network: what a request carries.
func (k *Keeper) Current() Session {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.session
}

// Capped reports that the sign-in reached its last day's cap: only a new code extends it.
func (k *Keeper) Capped() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.capped
}

// RenewFailing reports that the last renewal failed and the session is running down.
func (k *Keeper) RenewFailing() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.failing
}

// Fresh is the session, renewed first when it is due. A renewal that fails
// leaves the held session in use (it is still good) and rests a minute; an
// ended session is ErrSignedOut, and only a new code brings the phone back.
func (k *Keeper) Fresh(ctx context.Context) (Session, error) {
	k.mu.Lock()
	at := k.now()
	if !at.Before(time.UnixMilli(k.session.Exp)) {
		k.mu.Unlock()
		return Session{}, ErrSignedOut
	}
	due := !k.capped && time.UnixMilli(k.session.Exp).Sub(at) <= RenewAhead && !at.Before(k.restUntil)
	k.mu.Unlock()
	if due {
		// A renewed session that could not be stored is still the one to use: the error says so, the session is good.
		if err := k.renew(ctx); err != nil {
			return k.Current(), err
		}
	}
	return k.Current(), nil
}

// Newer is the session to retry with after the relay refused `token`: a
// newer one if a renewal made it meanwhile, or one more renewal at once when
// the last one went unanswered. ErrSignedOut when there is nothing newer:
// the sign-in is over, and only a new code brings the phone back.
func (k *Keeper) Newer(ctx context.Context, token string) (Session, error) {
	k.wait()
	k.mu.Lock()
	held, retry := k.session, k.unanswered && k.now().Before(time.UnixMilli(k.session.Exp))
	k.mu.Unlock()
	if held.Token != token {
		return held, nil
	}
	if retry {
		// Storing may fail; the renewed token is still the one to use.
		_ = k.renew(ctx)
		if next := k.Current(); next.Token != token {
			return next, nil
		}
	}
	return Session{}, ErrSignedOut
}

// wait lets a renewal in flight finish.
func (k *Keeper) wait() {
	k.mu.Lock()
	done := k.renewing
	k.mu.Unlock()
	if done != nil {
		<-done
	}
}

// renew runs one renewal, or waits for the one already out. Its error is only
// a renewed session that could not be stored; a failed renewal is Failing.
func (k *Keeper) renew(ctx context.Context) error {
	k.mu.Lock()
	if k.renewing != nil {
		done := k.renewing
		k.mu.Unlock()
		<-done
		return nil
	}
	done := make(chan struct{})
	k.renewing = done
	held := k.session
	k.mu.Unlock()

	next, err := k.registry.Renew(ctx, held, k.key)
	k.settle(next, err, held)
	close(done)
	if err != nil {
		return nil
	}
	// After the lock: storing may wait on the keychain. The renewed token is
	// the only good one now, and is held even if storing it failed.
	return k.keep(next)
}

// settle records what a renewal came to.
func (k *Keeper) settle(next Session, err error, held Session) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.renewing = nil
	if err != nil {
		k.restUntil = k.now().Add(RenewRest)
		k.failing = true
		// A refusal is an answer; anything else may have closed the held token unseen.
		var refused *Refusal
		k.unanswered = !errors.As(err, &refused) && !errors.Is(err, ErrSignedOut)
		return
	}
	k.unanswered, k.failing = false, false
	// No later than before: the sign-in's thirty days are the cap, and asking again would only close tokens.
	k.capped = next.Exp <= held.Exp
	k.session = next
}
