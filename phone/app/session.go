package main

import (
	"context"
	"errors"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/pair"
	"github.com/cookrew/cookrew-app/phone/core/plane"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// Registry is the account's API host. The app joins this one whatever a
// scanned link names (pair.JoinCode never trusts the link's host).
const Registry = "https://api.cookrew.dev"

// netTimeout bounds one step the user is waiting on.
const netTimeout = 45 * time.Second

// Phase is where the app stands.
type Phase int

const (
	// Opening: the keychain has not answered yet.
	Opening Phase = iota
	// Locked: the key is kept, and Face ID has not opened it (canceled): never the scanner,
	// which would join a new key over the kept one.
	Locked
	// Joining: no account yet, or the sign-in ended: the scanner shows.
	Joining
	// Joined: the phone is on the account.
	Joined
)

// MachineRow is one machine of the account as the list shows it.
type MachineRow struct {
	ID     string
	Name   string
	Online bool
	// Entered: the phone holds this machine's token.
	Entered bool
	// Note is why it is not entered, in words, or "".
	Note string
}

// Session is the app's state, as signals the screens read. Writes happen on
// the main thread: work runs in goroutines and posts its results back.
type Session struct {
	registry pair.Registry
	vault    Vault
	// keeper renews the sign-in; nil until the phone has joined.
	keeper *pair.Keeper

	Phase    *signal.Signal[Phase]
	State    *signal.Signal[pair.State]
	Machines *signal.Signal[[]MachineRow]
	Busy     *signal.Signal[bool]
	// Problem is the last failure, in words, or "".
	Problem *signal.Signal[string]
	// Ending says the sign-in is near its end and only a new code extends it, or "".
	Ending *signal.Signal[string]
}

// NewSession reads the keychain and, if the phone is on an account, enters
// every machine it can. Main thread.
func NewSession(vault Vault) (*Session, error) {
	registry, err := pair.NewRegistry(Registry, nil)
	if err != nil {
		return nil, err
	}
	s := &Session{
		registry: registry,
		vault:    vault,
		Phase:    signal.New(Opening),
		// Never equal: a new state or list is always a change to draw.
		State:    signal.NewFunc(pair.State{}, never[pair.State]),
		Machines: signal.NewFunc([]MachineRow(nil), never[[]MachineRow]),
		Busy:     signal.New(false),
		Problem:  signal.New(""),
		Ending:   signal.New(""),
	}
	s.Unlock()
	return s, nil
}

// Unlock reads the kept state, behind Face ID. Main thread; the prompt waits aside.
func (s *Session) Unlock() {
	s.Phase.Set(Opening)
	s.Problem.Set("")
	vault := s.vault
	go func() {
		state, err := vault.Load()
		ui.Post(func() {
			if err == nil {
				s.joined(state)
				return
			}
			if !errors.Is(err, errNoState) {
				s.Problem.Set(err.Error())
			}
			s.Phase.Set(afterLoad(err))
		})
	}()
}

// afterLoad is where the app stands after the keychain answered. The scanner
// shows only when nothing is kept, or the kept key is gone for good (Face ID
// changed, and it was cleared): anything else may still be a good key, and a
// join from the scanner would put a new one over it. Locked keeps it, and
// offers Face ID again, or a start over the person confirms.
func afterLoad(err error) Phase {
	switch {
	case err == nil:
		return Joined
	case errors.Is(err, errNoState), errors.Is(err, errFaceIDChanged):
		return Joining
	}
	return Locked
}

// StartOver forgets this phone's key and tokens, after the person confirmed:
// the next code joins it as a new phone. The account keeps the old one listed
// until it is removed in Devices. Main thread.
func (s *Session) StartOver() {
	vault := s.vault
	go func() {
		err := vault.Clear()
		ui.Post(func() {
			if err != nil {
				s.Problem.Set(err.Error())
				return
			}
			s.keeper = nil
			s.State.Set(pair.State{})
			s.Machines.Set(nil)
			s.Problem.Set("")
			s.Phase.Set(Joining)
		})
	}()
}

// joined makes the phone's sign-in the one kept and renewed. Main thread.
func (s *Session) joined(state pair.State) {
	device, err := state.Device()
	if err != nil {
		// A kept state that names no key: never the scanner on its own, only a confirmed start over.
		s.Problem.Set(err.Error())
		s.Phase.Set(Locked)
		return
	}
	// Nothing stored by the keeper itself: enter keeps the whole state, renewed session and all, after each run.
	s.keeper = pair.NewKeeper(s.registry, device.Key, state.Session, nil, nil)
	s.State.Set(state)
	s.Phase.Set(Joined)
	s.Refresh()
}

// Join spends a scanned or typed code: with the key this phone already holds
// when it has one (it stays one device on the account), else a new one. Main
// thread; the work runs aside.
func (s *Session) Join(scanned string) {
	if s.Busy.Peek() {
		return
	}
	if _, err := pair.JoinCode(scanned); err != nil {
		s.Problem.Set(err.Error())
		return
	}
	s.Busy.Set(true)
	s.Problem.Set("")
	held := s.State.Peek()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), netTimeout)
		defer cancel()
		state, err := s.join(ctx, held, scanned)
		// The code is spent the moment the registry answers: keep the state before anything else.
		var saveErr error
		if err == nil {
			saveErr = s.vault.Save(state)
		}
		ui.Post(func() {
			s.Busy.Set(false)
			if err != nil {
				s.Problem.Set(err.Error())
				return
			}
			// Joined either way: the code is spent, and a key not yet kept is tried again after the next refresh.
			s.joined(state)
			if saveErr != nil {
				s.Problem.Set("Joined, but the key is not kept yet: " + saveErr.Error())
			}
		})
	}()
}

// join is Rejoin for a phone that held a key, JoinAccount for a new one. Off the main thread.
func (s *Session) join(ctx context.Context, held pair.State, scanned string) (pair.State, error) {
	if held.Seed == "" {
		return pair.JoinAccount(ctx, s.registry, scanned, deviceName())
	}
	state, err := pair.Rejoin(ctx, s.registry, held, scanned)
	if errors.Is(err, pair.ErrNewDevice) {
		// One answer is not enough to let a key go (it may be another account's code): the person decides, with Start over.
		return held, errRemoved
	}
	return state, err
}

// errRemoved is a code the account would not join this phone's key with: removed in Devices, or another account's code.
var errRemoved = errors.New("the account would not take this phone's key: it was removed in Devices, or the code is another account's; Start over to join as a new phone")

// Refresh renews the sign-in if due, lists the account's machines and enters
// those the phone holds no token for. Main thread.
func (s *Session) Refresh() {
	if s.Busy.Peek() || s.keeper == nil {
		return
	}
	s.Busy.Set(true)
	state := s.State.Peek()
	keeper := s.keeper
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), netTimeout)
		defer cancel()
		next, rows, err := s.enter(ctx, keeper, state)
		ending := endingLine(keeper)
		ui.Post(func() {
			s.Busy.Set(false)
			s.State.Set(next)
			s.Ending.Set(ending)
			switch {
			case errors.Is(err, pair.ErrSignedOut), errors.Is(err, pair.ErrNotTrusted):
				// Over: the key stays, for the next code to bring this same phone back.
				s.Problem.Set("This phone needs a new code: on a Mac, open ⋯ → Phone app.")
				s.Phase.Set(Joining)
			case err != nil:
				s.Problem.Set(err.Error())
			default:
				s.Problem.Set("")
				s.Machines.Set(rows)
			}
		})
	}()
}

// enter renews the session if due, enters what it can, keeps the result and
// answers the rows. Off the main thread.
func (s *Session) enter(ctx context.Context, keeper *pair.Keeper, state pair.State) (pair.State, []MachineRow, error) {
	session, err := keeper.Fresh(ctx)
	if err != nil {
		return state, nil, err
	}
	next, outcomes, err := pair.EnterAll(ctx, s.registry, state.WithSession(session), pair.RelayRoad(s.registry))
	if saveErr := s.vault.Save(next); saveErr != nil && err == nil {
		err = saveErr
	}
	if err != nil {
		return next, nil, err
	}
	rows := make([]MachineRow, 0, len(outcomes))
	for _, o := range outcomes {
		rows = append(rows, MachineRow{ID: o.Machine.DeviceID, Name: o.Machine.Name, Online: o.Machine.Online, Entered: o.Entered, Note: note(o)})
	}
	return next, rows, nil
}

// endingLine warns before the sign-in's last day, or is "".
func endingLine(keeper *pair.Keeper) string {
	if !keeper.Capped() && !keeper.RenewFailing() {
		return ""
	}
	ends := time.UnixMilli(keeper.Current().Exp).Format("Jan 2")
	return "This phone's sign-in ends " + ends + ". Scan a new code from ⋯ → Phone app before then."
}

// note is an outcome in a few words.
func note(o pair.Outcome) string {
	switch {
	case o.Err == nil:
		return ""
	case errors.Is(o.Err, plane.ErrMachineOffline):
		return "Not connected"
	case errors.Is(o.Err, pair.ErrRegrant):
		return "Did not take this phone's pass yet"
	case pair.Refused(o):
		return "Turned this phone away"
	}
	return "Not reached"
}

// Road is the relay to a machine the phone holds a token for.
func (s *Session) Road(machineID string) (plane.Plane, error) {
	state := s.State.Peek()
	held, ok := state.Machines[machineID]
	if !ok {
		return nil, errors.New("this phone is not on that machine yet")
	}
	return plane.NewRelay(s.registry.Origin(), held.ID, plane.StaticCredentials(state.Session.Token, held.Token), nil)
}

// never is the equality of a value that is only ever set when it changed.
func never[T any](_, _ T) bool { return false }

// deviceName is what the account's Devices list calls this phone.
func deviceName() string { return "iPhone" }
