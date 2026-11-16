package pair

import (
	"context"
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
// Safe for concurrent use; one renewal at a time, because each renewal closes
// the session before it and two would race to leave a dead token.
type Keeper struct {
	registry Registry
	key      account.Key
	now      func() time.Time
	// keep stores a renewed session (the keychain on the phone); a failure is reported, the session still used.
	keep func(Session) error

	mu        sync.Mutex
	session   Session
	restUntil time.Time
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

// Fresh is the session, renewed first when it is due. A renewal that fails
// leaves the held session in use (it is still good) and rests a minute; an
// ended session is ErrSignedOut, and only a new code brings the phone back.
func (k *Keeper) Fresh(ctx context.Context) (Session, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	at := k.now()
	ends := time.UnixMilli(k.session.Exp)
	if !at.Before(ends) {
		return Session{}, ErrSignedOut
	}
	if ends.Sub(at) > RenewAhead || at.Before(k.restUntil) {
		return k.session, nil
	}
	next, err := k.registry.Renew(ctx, k.session, k.key)
	if err != nil {
		// Whatever the failure — no network, or a 401 (a spent nonce answers
		// the same as an ended sitting) — the held token still opens until its
		// end: rest a minute and ask again then.
		k.restUntil = at.Add(RenewRest)
		return k.session, nil
	}
	k.session = next
	k.restUntil = time.Time{}
	if err := k.keep(next); err != nil {
		return next, err
	}
	return next, nil
}
