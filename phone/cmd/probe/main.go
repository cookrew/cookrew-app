// Command probe runs the phone's core against a LOCAL Cookrew registry and the
// machines behind its relay: join by a QR, take the phone pass, enter every
// machine, call one. It is how the client is proved on a Mac before it runs on
// a phone, and it never talks to production: the registry is named on the
// command line, never read from the environment (agent panes export
// COOKREW_REGISTRY=https://cookrew.dev), and only a loopback one is accepted.
//
//	probe -registry http://127.0.0.1:8790 -state ./phone.json join 'https://cookrew.dev/join#K7QM-2XPD'
//	probe -registry … -state … enter
//	probe -registry … -state … machines
//	probe -registry … -state … call <machine-id> api/auth/status
//	probe -registry … -state … renew
//	probe -registry … -state … drop <machine-id>
//	probe -registry … -state … rejoin 'https://cookrew.dev/join#M2XB-7KQ4'
//
// Each command prints one fact per line, for a person or a test to read.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/pair"
	"github.com/cookrew/cookrew-app/phone/core/plane"
)

const usage = `usage: probe -registry http://127.0.0.1:PORT -state FILE <command>

commands:
  join <qr-link-or-code>   join the account as a trusted phone
  enter                    enter every machine the phone holds no token for
  machines                 list the machines the phone holds tokens for
  call <machine> <route>   GET one route of a machine through the relay
  renew                    renew the session if it is due
  drop <machine>           forget a token a machine no longer takes (the app does this on its 401)
  rejoin <qr-link-or-code> join again with the key this phone holds`

// callTimeout bounds one command.
const callTimeout = 60 * time.Second

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("probe", flag.ContinueOnError)
	registryFlag := flags.String("registry", "", "a LOCAL registry origin (loopback only)")
	stateFlag := flags.String("state", "", "the file the phone's state is kept in (0600)")
	nameFlag := flags.String("name", "Probe iPhone", "the device name the account shows")
	if err := flags.Parse(args); err != nil {
		return err
	}
	rest := flags.Args()
	if len(rest) == 0 || *registryFlag == "" || *stateFlag == "" {
		return errors.New(usage)
	}
	if err := loopbackOnly(*registryFlag); err != nil {
		return err
	}
	registry, err := pair.NewRegistry(*registryFlag, nil)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	switch rest[0] {
	case "join":
		if len(rest) != 2 {
			return errors.New(usage)
		}
		return join(ctx, registry, *stateFlag, rest[1], *nameFlag, out)
	case "enter":
		return enter(ctx, registry, *stateFlag, out)
	case "machines":
		return machines(*stateFlag, out)
	case "call":
		if len(rest) != 3 {
			return errors.New(usage)
		}
		return call(ctx, registry, *stateFlag, rest[1], rest[2], out)
	case "renew":
		return renew(ctx, registry, *stateFlag, out)
	case "drop":
		if len(rest) != 2 {
			return errors.New(usage)
		}
		return drop(registry, *stateFlag, rest[1], out)
	case "rejoin":
		if len(rest) != 2 {
			return errors.New(usage)
		}
		return rejoin(ctx, registry, *stateFlag, rest[1], out)
	}
	return errors.New(usage)
}

// loopbackOnly refuses every registry that is not this machine: the probe is
// for a local registry under test, never cookrew.dev. An address, not a name:
// a name is whatever the resolver says it is.
func loopbackOnly(origin string) error {
	u, err := url.Parse(origin)
	if err == nil {
		if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return fmt.Errorf("refusing %q: the probe only talks to a registry on this machine (127.0.0.1 or [::1])", origin)
}

func join(ctx context.Context, registry pair.Registry, file, scanned, name string, out io.Writer) error {
	switch _, err := os.Stat(file); {
	case err == nil:
		return fmt.Errorf("%s already holds a phone; use rejoin, or another -state", file)
	case !errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("checking %s: %w", file, err)
	}
	state, err := pair.JoinAccount(ctx, registry, scanned, name)
	if err != nil {
		return err
	}
	// The code is spent: the state is kept before anything else can fail.
	if err := save(file, state); err != nil {
		return err
	}
	fmt.Fprintf(out, "joined %s %s\n", state.Session.Username, state.Session.DeviceID)
	return nil
}

func enter(ctx context.Context, registry pair.Registry, file string, out io.Writer) error {
	state, err := load(file, registry)
	if err != nil {
		return err
	}
	next, outcomes, err := pair.EnterAll(ctx, registry, state, pair.RelayRoad(registry))
	if saveErr := save(file, next); saveErr != nil {
		return saveErr
	}
	if err != nil {
		return err
	}
	for _, o := range outcomes {
		switch {
		case o.Fresh:
			fmt.Fprintf(out, "entered %s %s until %d\n", o.Machine.DeviceID, o.Machine.Name, next.Machines[o.Machine.DeviceID].Until)
		case o.Entered:
			fmt.Fprintf(out, "held %s %s\n", o.Machine.DeviceID, o.Machine.Name)
		case errors.Is(o.Err, plane.ErrMachineOffline):
			fmt.Fprintf(out, "away %s %s\n", o.Machine.DeviceID, o.Machine.Name)
		default:
			fmt.Fprintf(out, "refused %s %s: %v\n", o.Machine.DeviceID, o.Machine.Name, o.Err)
		}
	}
	return nil
}

func machines(file string, out io.Writer) error {
	state, err := readState(file)
	if err != nil {
		return err
	}
	for _, id := range state.MachineIDs() {
		m := state.Machines[id]
		fmt.Fprintf(out, "machine %s %s until %d\n", m.ID, m.Name, m.Until)
	}
	return nil
}

// call GETs one route of a machine down the relay with the machine's token.
func call(ctx context.Context, registry pair.Registry, file, machine, route string, out io.Writer) error {
	state, err := load(file, registry)
	if err != nil {
		return err
	}
	held, ok := state.Machines[strings.ToLower(machine)]
	if !ok {
		return fmt.Errorf("this phone holds no token for %s; run enter first", machine)
	}
	road, err := plane.NewRelay(registry.Origin(), held.ID, plane.StaticCredentials(state.Session.Token, held.Token), nil)
	if err != nil {
		return err
	}
	resp, err := road.Do(ctx, plane.Request{Method: http.MethodGet, Route: route})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%d %s\n", resp.StatusCode, strings.TrimSpace(string(body)))
	return nil
}

func renew(ctx context.Context, registry pair.Registry, file string, out io.Writer) error {
	state, err := load(file, registry)
	if err != nil {
		return err
	}
	device, err := state.Device()
	if err != nil {
		return err
	}
	keeper := pair.NewKeeper(registry, device.Key, state.Session, nil, nil)
	session, err := keeper.Fresh(ctx)
	if err != nil {
		return err
	}
	if err := save(file, state.WithSession(session)); err != nil {
		return err
	}
	standing := "held"
	switch {
	case keeper.RenewFailing():
		standing = "held (renewal failing)"
	case keeper.Capped():
		standing = "renewed (capped: a new code before it ends)"
	case session.Token != state.Session.Token:
		standing = "renewed"
	}
	fmt.Fprintf(out, "session %s until %d\n", standing, session.Exp)
	return nil
}

func drop(registry pair.Registry, file, machine string, out io.Writer) error {
	state, err := load(file, registry)
	if err != nil {
		return err
	}
	if err := save(file, state.WithoutMachine(strings.ToLower(machine))); err != nil {
		return err
	}
	fmt.Fprintf(out, "dropped %s\n", strings.ToLower(machine))
	return nil
}

func rejoin(ctx context.Context, registry pair.Registry, file, scanned string, out io.Writer) error {
	state, err := load(file, registry)
	if err != nil {
		return err
	}
	next, err := pair.Rejoin(ctx, registry, state, scanned)
	if err != nil {
		return err
	}
	if err := save(file, next); err != nil {
		return err
	}
	fmt.Fprintf(out, "rejoined %s %s\n", next.Session.Username, next.Session.DeviceID)
	return nil
}

// load reads the state and checks it was made against this registry: a phone's
// key and tokens are never carried to another one.
func load(file string, registry pair.Registry) (pair.State, error) {
	state, err := readState(file)
	if err != nil {
		return pair.State{}, err
	}
	if state.Registry != registry.Origin() {
		return pair.State{}, fmt.Errorf("%s belongs to %s, not %s", file, state.Registry, registry.Origin())
	}
	return state, nil
}

func readState(file string) (pair.State, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return pair.State{}, fmt.Errorf("reading the phone's state: %w", err)
	}
	var state pair.State
	if err := json.Unmarshal(raw, &state); err != nil {
		return pair.State{}, fmt.Errorf("decoding the phone's state: %w", err)
	}
	return state, nil
}

// save writes the state whole, 0600, by rename: it holds the device key. The
// temporary file is made fresh (never one left behind, nor a link someone
// placed) and synced before it takes the name.
func save(file string, state pair.State) error {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".probe-state-*")
	if err != nil {
		return err
	}
	done := false
	defer func() {
		if !done {
			_ = os.Remove(temp.Name())
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(raw); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), file); err != nil {
		return err
	}
	done = true
	return nil
}
