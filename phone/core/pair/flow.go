package pair

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"

	"github.com/cookrew/cookrew-app/phone/core/account"
	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// State is everything the phone keeps about its place on the account: the
// device key's seed, the session, and each machine's token. It is the one
// secret the app stores (the keychain, behind Face ID), as one value, and it
// is never mutated: every step answers a new State.
type State struct {
	Registry string  `json:"registry"`
	Name     string  `json:"name"`
	Seed     string  `json:"seed"`
	Session  Session `json:"session"`
	// Machines by machine id.
	Machines map[string]Machine `json:"machines"`
}

// Device is the phone the state names.
func (s State) Device() (Device, error) {
	seed, err := hex.DecodeString(s.Seed)
	if err != nil {
		return Device{}, fmt.Errorf("pair: the kept device seed: %w", err)
	}
	key, err := account.FromSeed(seed)
	if err != nil {
		return Device{}, err
	}
	return NewDevice(key, s.Name)
}

// WithSession is the state holding a renewed session.
func (s State) WithSession(next Session) State {
	return State{Registry: s.Registry, Name: s.Name, Seed: s.Seed, Session: next, Machines: s.Machines}
}

// WithMachine is the state holding one more (or a replaced) machine token.
func (s State) WithMachine(m Machine) State {
	machines := make(map[string]Machine, len(s.Machines)+1)
	for id, held := range s.Machines {
		machines[id] = held
	}
	machines[m.ID] = m
	return State{Registry: s.Registry, Name: s.Name, Seed: s.Seed, Session: s.Session, Machines: machines}
}

// WithoutMachine is the state that no longer holds a machine's token (it refused it).
func (s State) WithoutMachine(id string) State {
	machines := make(map[string]Machine, len(s.Machines))
	for held, m := range s.Machines {
		if held != id {
			machines[held] = m
		}
	}
	return State{Registry: s.Registry, Name: s.Name, Seed: s.Seed, Session: s.Session, Machines: machines}
}

// MachineIDs are the machines the state holds tokens for, in a stable order.
func (s State) MachineIDs() []string {
	ids := make([]string, 0, len(s.Machines))
	for id := range s.Machines {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// JoinAccount makes this phone's key and spends the scanned code: the phone is
// now a trusted phone of the account, with a session and no machine yet. The
// code is spent whatever happens next, so the caller stores the answer at once.
func JoinAccount(ctx context.Context, registry Registry, scanned, name string) (State, error) {
	code, err := JoinCode(scanned)
	if err != nil {
		return State{}, err
	}
	key, err := account.NewKey()
	if err != nil {
		return State{}, err
	}
	device, err := NewDevice(key, name)
	if err != nil {
		return State{}, err
	}
	session, err := registry.Join(ctx, code, device)
	if err != nil {
		return State{}, err
	}
	return State{Registry: registry.Origin(), Name: name, Seed: hex.EncodeToString(key.Seed()), Session: session, Machines: map[string]Machine{}}, nil
}

// Road is the plane to one machine for a session, with no machine token yet:
// the relay, while the phone is not on the machine's own network.
type Road func(machineID string, session string) (plane.Plane, error)

// RelayRoad is Road over cookrew.dev's relay.
func RelayRoad(registry Registry) Road {
	return func(machineID, session string) (plane.Plane, error) {
		return plane.NewRelay(registry.Origin(), machineID, plane.StaticCredentials(session, ""), nil)
	}
}

// Outcome is what entering one machine came to.
type Outcome struct {
	Machine Desktop
	// Entered is true when the phone now holds a token for it (already, or just now).
	Entered bool
	// Fresh is true when the token was handed over in this run.
	Fresh bool
	Err   error
}

// EnterAll takes the phone into every machine of the account it does not hold
// a token for yet: one phone pass, then each machine's door. A machine that is
// offline, or turns the phone away, is reported and tried again next time;
// machines added to the account later are entered the same way.
func EnterAll(ctx context.Context, registry Registry, state State, road Road) (State, []Outcome, error) {
	device, err := state.Device()
	if err != nil {
		return state, nil, err
	}
	desktops, err := registry.Desktops(ctx, state.Session.Token)
	if err != nil {
		return state, nil, err
	}
	missing := make([]Desktop, 0, len(desktops))
	outcomes := make([]Outcome, 0, len(desktops))
	for _, d := range desktops {
		if _, held := state.Machines[d.DeviceID]; held {
			outcomes = append(outcomes, Outcome{Machine: d, Entered: true})
			continue
		}
		missing = append(missing, d)
	}
	if len(missing) == 0 {
		return state, outcomes, nil
	}
	// One pass for every machine: it is twelve hours long and asks no proof.
	pass, err := registry.PhonePass(ctx, state.Session.Token)
	if err != nil {
		return state, outcomes, err
	}
	next := state
	for _, d := range missing {
		if !d.Online {
			outcomes = append(outcomes, Outcome{Machine: d, Err: plane.ErrMachineOffline})
			continue
		}
		machine, err := enterOne(ctx, road, device, pass, d, state.Session.Token)
		if err != nil {
			outcomes = append(outcomes, Outcome{Machine: d, Err: err})
			continue
		}
		next = next.WithMachine(machine)
		outcomes = append(outcomes, Outcome{Machine: d, Entered: true, Fresh: true})
	}
	return next, outcomes, nil
}

func enterOne(ctx context.Context, road Road, device Device, pass Pass, d Desktop, session string) (Machine, error) {
	p, err := road(d.DeviceID, session)
	if err != nil {
		return Machine{}, err
	}
	return Enter(ctx, p, device, pass, d)
}

// Refused reports whether an outcome means the machine will not take this
// phone on this pass (as opposed to being away): the app says so and stops asking.
func Refused(o Outcome) bool {
	return o.Err != nil && (errors.Is(o.Err, ErrDoorRefused) || errors.Is(o.Err, ErrWrongMachine) || errors.Is(o.Err, ErrNoDoor))
}
