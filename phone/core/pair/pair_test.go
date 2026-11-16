package pair

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/account"
	"github.com/cookrew/cookrew-app/phone/core/plane"
)

const (
	macA = "6c1f3a52-0e9b-4c7d-8a21-5f0d9e3b7c41"
	macB = "7d2e4b63-1fac-4d8e-9b32-6a1e0f4c8d52"
)

// world is a fake cookrew.dev and its relay in one server, holding to the
// rules the real ones keep: a phone's code makes a phone, a pass is for one
// key, a machine's door wants a fresh signature over its own challenge.
type world struct {
	t       *testing.T
	mu      sync.Mutex
	code    string
	session string
	exp     int64
	device  struct {
		id, name string
		jwk      account.JWK
	}
	trusted bool
	online  map[string]bool
	// forgotten machines turn the phone away.
	forgotten map[string]bool
	// liar answers every begin in macA's name; liarFinish only the finish.
	liar       bool
	liarFinish bool
	// watchScope answers a finish with a watch's token; door404 has no door; regrant refuses the pass with 401.
	watchScope bool
	door404    bool
	regrant    bool
	// relayEnds answers the relay's own 401 for this machine.
	relayEnds string
	// extend makes a renewal add time; the real registry caps it at the sign-in's thirtieth day.
	extend bool
	// joins numbers the sessions; refuseDevice answers a join with 400 bad_device, locked with 403.
	joins        int
	refuseDevice bool
	locked       bool
	awaitingKeep bool
	renewDelay   time.Duration
	renewDrop    bool
	held         map[string]account.PairChallenge
	renewals     int
	nonces       int
	nonce        string
	entered      []string
	srv          *httptest.Server
}

func newWorld(t *testing.T) *world {
	w := &world{t: t, code: "K7QM-2XPD", online: map[string]bool{macA: true, macB: true}, forgotten: map[string]bool{}, held: map[string]account.PairChallenge{}}
	w.srv = httptest.NewServer(http.HandlerFunc(w.serve))
	t.Cleanup(w.srv.Close)
	return w
}

func (w *world) answer(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func (w *world) bearer(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func (w *world) serve(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v2/join":
		dev, _ := body["device"].(map[string]any)
		if body["code"] != w.code {
			w.answer(rw, 401, map[string]string{"error": "bad_credentials"})
			return
		}
		w.code = "" // spent
		if w.refuseDevice {
			w.answer(rw, 400, map[string]string{"error": "bad_device"})
			return
		}
		if w.locked {
			w.answer(rw, 403, map[string]string{"error": "password_change_required"})
			return
		}
		if dev["kind"] != "phone" {
			w.answer(rw, 400, map[string]string{"error": "bad_device"})
			return
		}
		raw, _ := json.Marshal(dev["jwk"])
		_ = json.Unmarshal(raw, &w.device.jwk)
		w.device.id, _ = dev["id"].(string)
		// The registry's rule: a phone's code wants the key's proof over the code.
		if !w.verify(JoinProofMessage(body["code"].(string), w.device.id), body["proof"]) {
			w.answer(rw, 401, map[string]string{"error": "bad_credentials"})
			return
		}
		w.device.name, _ = dev["name"].(string)
		w.trusted = true
		w.joins++
		w.session = fmt.Sprintf("session-%d", w.joins)
		w.exp = time.Now().Add(30 * 24 * time.Hour).UnixMilli()
		w.answer(rw, 201, map[string]any{"token": w.session, "exp": w.exp, "deviceId": w.device.id, "username": "anvztor"})
	case r.URL.Path == "/v2/me/device-grant/phone":
		if w.bearer(r) != w.session || w.session == "" {
			w.answer(rw, 401, map[string]string{"error": "unauthenticated"})
			return
		}
		if w.awaitingKeep {
			w.answer(rw, 403, map[string]string{"error": "not_confirmed", "message": "Waiting for the Mac that showed the code: tap Keep there."})
			return
		}
		if !w.trusted {
			w.answer(rw, 403, map[string]string{"error": "not_phone"})
			return
		}
		w.answer(rw, 201, map[string]any{"grant": "pass-for-" + w.device.id, "exp": time.Now().Add(12 * time.Hour).UnixMilli(), "deviceId": w.device.id})
	case r.URL.Path == "/v2/me/desktops":
		// A phone not kept yet opens nothing: the account answers its session as unknown.
		if w.bearer(r) != w.session || w.session == "" || w.awaitingKeep {
			w.answer(rw, 401, map[string]string{"error": "unauthenticated"})
			return
		}
		w.answer(rw, 200, []map[string]any{{"deviceId": macA, "name": "Solis", "online": w.online[macA]}, {"deviceId": macB, "name": "Lune", "online": w.online[macB]}})
	case r.URL.Path == "/v2/sessions/renew-nonce":
		w.nonces++
		w.nonce = "bm9uY2Utb2YtcmVuZXdhbC0xMjM"
		w.answer(rw, 200, map[string]any{"nonce": w.nonce, "expiresAt": 0})
	case r.URL.Path == "/v2/sessions/renew":
		if w.renewDelay > 0 {
			w.mu.Unlock()
			time.Sleep(w.renewDelay)
			w.mu.Lock()
		}
		if w.renewDrop {
			// The renewal happens, and the answer is lost on the way back.
			w.renewDrop = false
			w.renewals++
			w.session = "session-renewed-unseen"
			hj, _ := rw.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
			return
		}
		msg, _ := account.RenewMessage("anvztor", w.device.id, w.nonce)
		if body["nonce"] != w.nonce || !w.verify(msg, body["sig"]) {
			w.answer(rw, 401, map[string]string{"error": "bad_credentials"})
			return
		}
		w.nonce = ""
		w.renewals++
		w.session = fmt.Sprintf("session-renewed-%d", w.renewals)
		if w.extend {
			// Always later than before, even within the same millisecond as the join.
			w.exp = max(time.Now().Add(30*24*time.Hour).UnixMilli(), w.exp+time.Hour.Milliseconds())
		}
		w.answer(rw, 201, map[string]any{"token": w.session, "exp": w.exp, "deviceId": w.device.id, "username": "anvztor"})
	case strings.HasPrefix(r.URL.Path, "/api/m/"):
		w.door(rw, r, body)
	default:
		w.answer(rw, 404, map[string]string{"error": "not_found"})
	}
}

func (w *world) verify(message string, sig any) bool {
	s, _ := sig.(string)
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return false
	}
	pub, err := base64.RawURLEncoding.DecodeString(w.device.jwk.X)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	return ed25519.Verify(pub, []byte(message), raw)
}

// door is a machine's account door behind the relay (src/main/account-pair.ts).
func (w *world) door(rw http.ResponseWriter, r *http.Request, body map[string]any) {
	if r.Header.Get(plane.SessionHeader) != w.session {
		w.answer(rw, 401, map[string]string{"error": "unauthenticated"})
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/m/"), "/", 2)
	machine, route := parts[0], parts[1]
	if machine == w.relayEnds {
		w.answer(rw, 401, map[string]string{"error": "unauthenticated"})
		return
	}
	if !w.online[machine] {
		w.answer(rw, 503, map[string]string{"error": "no_link"})
		return
	}
	if w.door404 {
		w.answer(rw, 404, map[string]string{"error": "This machine does not take the account at the door."})
		return
	}
	if w.regrant || body["grant"] != "pass-for-"+w.device.id {
		w.answer(rw, 401, map[string]any{"ok": false, "outcome": "regrant", "error": "That pass is no longer good."})
		return
	}
	if w.forgotten[machine] {
		w.answer(rw, 403, map[string]any{"ok": false, "outcome": "refused", "error": "This Mac was told to forget this phone."})
		return
	}
	named := machine
	if w.liar {
		named = macA
	}
	switch route {
	case "api/pair/begin":
		c := account.PairChallenge{ChallengeID: "2f9d6e1a-4b3c-4d5e-9f60-718293a4b5c6", Nonce: "bm9uY2Utb2YtdGhpcnR5LXR3by1ieXRlcy1sb25nLiE", DesktopID: named}
		w.held[machine] = c
		w.answer(rw, 200, c)
	case "api/pair":
		c, ok := w.held[machine]
		delete(w.held, machine)
		transcript, _ := account.PairTranscript(c, w.device.id)
		if !ok || body["challengeId"] != c.ChallengeID || !w.verify(transcript, body["sig"]) {
			w.answer(rw, 401, map[string]any{"ok": false, "outcome": "refused", "error": "signature did not open"})
			return
		}
		w.entered = append(w.entered, machine)
		answer := map[string]any{"ok": true, "outcome": "admitted", "deviceId": w.device.id, "desktopId": named, "token": "token-on-" + machine, "until": 0}
		if w.liarFinish {
			answer["desktopId"] = macA
		}
		if w.watchScope {
			answer["scope"] = "watch"
		}
		w.answer(rw, 200, answer)
	}
}

func (w *world) registry() Registry {
	r, err := NewRegistry(w.srv.URL, nil)
	if err != nil {
		w.t.Fatal(err)
	}
	return r
}

func TestJoinCodeReadsTheQRAndWhatPeopleType(t *testing.T) {
	for in, want := range map[string]string{
		"https://cookrew.dev/join#K7QM-2XPD":  "K7QM-2XPD",
		"k7qm2xpd":                            "K7QM-2XPD",
		" K7QM 2XPD ":                         "K7QM-2XPD",
		"https://evil.example/join#k7qm-2xpd": "K7QM-2XPD",
	} {
		got, err := JoinCode(in)
		if err != nil || got != want {
			t.Errorf("JoinCode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "K7QM-2XP", "O0IL-1234", "https://cookrew.dev/join", "K7QM-2XPDX"} {
		if _, err := JoinCode(bad); !errors.Is(err, ErrNotACode) {
			t.Errorf("JoinCode(%q) should refuse", bad)
		}
	}
}

func TestRegistryIsHttpsOrLoopbackOnly(t *testing.T) {
	for _, ok := range []string{"https://cookrew.dev", "http://127.0.0.1:8787", "http://localhost:1"} {
		if _, err := NewRegistry(ok, nil); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://cookrew.dev", "https://cookrew.dev/v2", "https://u:p@cookrew.dev", "ftp://x"} {
		if _, err := NewRegistry(bad, nil); err == nil {
			t.Errorf("%s should be refused", bad)
		}
	}
}

func TestTheWholeWayIn(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	ctx := context.Background()
	state, err := JoinAccount(ctx, reg, "https://cookrew.dev/join#k7qm-2xpd", "iPhone")
	if err != nil {
		t.Fatal(err)
	}
	device, err := state.Device()
	if err != nil {
		t.Fatal(err)
	}
	if state.Session.Token != "session-1" || state.Session.DeviceID != device.ID || w.device.name != "iPhone" {
		t.Fatalf("joined as %+v", state.Session)
	}
	next, outcomes, err := EnterAll(ctx, reg, state, RelayRoad(reg))
	if err != nil {
		t.Fatal(err)
	}
	if got := next.MachineIDs(); len(got) != 2 || next.Machines[macA].Token != "token-on-"+macA || next.Machines[macB].Until != 0 {
		t.Fatalf("machines = %+v", next.Machines)
	}
	for _, o := range outcomes {
		if !o.Entered || !o.Fresh {
			t.Errorf("%s: %+v", o.Machine.Name, o)
		}
	}
	// The state answered is a new one: the old one still holds no machine.
	if len(state.Machines) != 0 {
		t.Fatal("EnterAll changed the state it was given")
	}
	// Run again: nothing new to enter, no pass asked for, no door knocked on.
	before := len(w.entered)
	if _, again, err := EnterAll(ctx, reg, next, RelayRoad(reg)); err != nil || len(w.entered) != before || again[0].Fresh {
		t.Fatalf("second run: %v, entered %d", err, len(w.entered)-before)
	}
}

func TestAMachineAwayIsTriedNextTime(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	ctx := context.Background()
	state, _ := JoinAccount(ctx, reg, "K7QM-2XPD", "iPhone")
	w.online[macB] = false
	next, outcomes, err := EnterAll(ctx, reg, state, RelayRoad(reg))
	if err != nil {
		t.Fatal(err)
	}
	if _, in := next.Machines[macB]; in || !errors.Is(outcomes[1].Err, plane.ErrMachineOffline) {
		t.Fatalf("away machine: %+v", outcomes[1])
	}
	w.online[macB] = true
	later, _, _ := EnterAll(ctx, reg, next, RelayRoad(reg))
	if later.Machines[macB].Token == "" {
		t.Fatal("the machine that came back was not entered")
	}
}

func TestAMachineThatForgotThePhoneTurnsItAway(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.forgotten[macA] = true
	next, outcomes, _ := EnterAll(context.Background(), reg, state, RelayRoad(reg))
	if _, in := next.Machines[macA]; in || !Refused(outcomes[0]) {
		t.Fatalf("forgotten machine: %+v", outcomes[0])
	}
}

func TestNeverSignsForAMachineAnsweringInAnotherOnesName(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.liar = true
	next, outcomes, _ := EnterAll(context.Background(), reg, state, RelayRoad(reg))
	if !errors.Is(outcomes[1].Err, ErrWrongMachine) {
		t.Fatalf("liar: %+v", outcomes[1])
	}
	if _, in := next.Machines[macB]; in {
		t.Fatal("kept a token from a machine that answered in another's name")
	}
	for _, m := range w.entered {
		if m == macB {
			t.Fatal("signed a challenge macB passed on in macA's name")
		}
	}
}

func TestAWrongOrSpentCode(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	if _, err := JoinAccount(context.Background(), reg, "AAAA-BBBB", "iPhone"); !errors.Is(err, ErrWrongCode) {
		t.Fatalf("wrong code: %v", err)
	}
	if _, err := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone"); err != nil {
		t.Fatal(err)
	}
	if _, err := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone"); !errors.Is(err, ErrWrongCode) {
		t.Fatalf("spent code: %v", err)
	}
}

func TestAPhoneNoLongerTrustedOrSignedOutIsToldSo(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.trusted = false
	if _, _, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); !errors.Is(err, ErrNotTrusted) {
		t.Fatalf("untrusted: %v", err)
	}
	w.session = "someone-else"
	if _, _, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("signed out: %v", err)
	}
}

func TestKeeperRenewsAWeekAheadAndNeverAfter(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	device, _ := state.Device()
	w.extend = true
	clock := time.Now()
	var kept []Session
	k := NewKeeper(reg, device.Key, state.Session, func() time.Time { return clock }, func(s Session) error {
		kept = append(kept, s)
		return nil
	})
	if s, _ := k.Fresh(context.Background()); s.Token != "session-1" || w.renewals != 0 {
		t.Fatalf("renewed early: %+v", s)
	}
	clock = time.UnixMilli(state.Session.Exp).Add(-RenewAhead + time.Hour)
	s, err := k.Fresh(context.Background())
	if err != nil || s.Token != "session-renewed-1" || w.renewals != 1 || len(kept) != 1 || k.Capped() {
		t.Fatalf("due: %+v %v renewals=%d kept=%d", s, err, w.renewals, len(kept))
	}
	clock = time.UnixMilli(s.Exp).Add(time.Second)
	if _, err := k.Fresh(context.Background()); !errors.Is(err, ErrSignedOut) || w.renewals != 1 {
		t.Fatalf("after the end: %v renewals=%d", err, w.renewals)
	}
}

func TestKeeperRestsAfterAFailedRenewalAndKeepsTheHeldToken(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	stranger, _ := account.NewKey()
	clock := time.UnixMilli(state.Session.Exp).Add(-time.Hour)
	k := NewKeeper(reg, stranger, state.Session, func() time.Time { return clock }, nil)
	s, err := k.Fresh(context.Background())
	if err != nil || s.Token != "session-1" {
		t.Fatalf("a failed renewal must leave the held session: %+v %v", s, err)
	}
	if w.nonces != 1 {
		t.Fatalf("one renewal tried, %d nonces asked", w.nonces)
	}
	clock = clock.Add(30 * time.Second)
	_, _ = k.Fresh(context.Background())
	if w.nonces != 1 {
		t.Fatal("asked again inside the rest")
	}
	clock = clock.Add(RenewRest)
	_, _ = k.Fresh(context.Background())
	if w.nonces != 2 {
		t.Fatal("did not ask again after the rest")
	}
}

func TestStateIsAValue(t *testing.T) {
	s := State{Machines: map[string]Machine{macA: {ID: macA}}}
	t2 := s.WithMachine(Machine{ID: macB}).WithoutMachine(macA)
	if len(s.Machines) != 1 || len(t2.Machines) != 1 || t2.Machines[macB].ID != macB {
		t.Fatalf("s=%v t2=%v", s.Machines, t2.Machines)
	}
}

func TestRejoinKeepsThePhonesKeyAndItsMachines(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	ctx := context.Background()
	state, _ := JoinAccount(ctx, reg, "K7QM-2XPD", "iPhone")
	entered, _, _ := EnterAll(ctx, reg, state, RelayRoad(reg))
	before, _ := entered.Device()
	w.code = "M2XB-7KQ4"
	w.trusted = false
	again, err := Rejoin(ctx, reg, entered, "https://cookrew.dev/join#m2xb-7kq4")
	if err != nil {
		t.Fatal(err)
	}
	after, _ := again.Device()
	if after.ID != before.ID || again.Seed != entered.Seed || !w.trusted {
		t.Fatalf("rejoined as another phone: %s → %s", before.ID, after.ID)
	}
	if len(again.Machines) != 2 || again.Session.Token != "session-2" {
		t.Fatalf("rejoin lost the machines or the session: %+v", again)
	}
	if _, err := Rejoin(ctx, reg, again, "M2XB-7KQ4"); !errors.Is(err, ErrWrongCode) {
		t.Fatalf("a spent code: %v", err)
	}
}

func TestKeeperStopsAtTheSignInsCap(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	device, _ := state.Device()
	clock := time.UnixMilli(state.Session.Exp).Add(-RenewAhead + time.Hour)
	k := NewKeeper(reg, device.Key, state.Session, func() time.Time { return clock }, nil)
	first, _ := k.Fresh(context.Background())
	if w.renewals != 1 || !k.Capped() || first.Exp != state.Session.Exp {
		t.Fatalf("renewals=%d capped=%v", w.renewals, k.Capped())
	}
	// Capped: asking again would only close the token a request is holding.
	clock = clock.Add(time.Hour)
	if s, _ := k.Fresh(context.Background()); w.renewals != 1 || s.Token != first.Token {
		t.Fatalf("renewed past the cap: renewals=%d", w.renewals)
	}
}

func TestKeeperRenewsOnceForManyAskers(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	device, _ := state.Device()
	w.extend = true
	w.renewDelay = 50 * time.Millisecond
	clock := time.UnixMilli(state.Session.Exp).Add(-time.Hour)
	k := NewKeeper(reg, device.Key, state.Session, func() time.Time { return clock }, nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = k.Fresh(context.Background())
		}()
	}
	// While the renewal is out, Current answers at once.
	time.Sleep(10 * time.Millisecond)
	started := time.Now()
	_ = k.Current()
	if time.Since(started) > 20*time.Millisecond {
		t.Fatal("Current waited on the network")
	}
	wg.Wait()
	if w.renewals != 1 {
		t.Fatalf("%d renewals for one due session", w.renewals)
	}
}

func TestNewerRetriesARenewalWhoseAnswerWasLost(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	device, _ := state.Device()
	w.extend = true
	w.renewDrop = true
	clock := time.UnixMilli(state.Session.Exp).Add(-time.Hour)
	k := NewKeeper(reg, device.Key, state.Session, func() time.Time { return clock }, nil)
	held, _ := k.Fresh(context.Background())
	if held.Token != state.Session.Token || !k.RenewFailing() {
		t.Fatalf("a lost answer: held %q failing=%v", held.Token, k.RenewFailing())
	}
	// The relay refuses the held token (the lost renewal closed it): Newer renews at once, rest or not.
	next, err := k.Newer(context.Background(), held.Token)
	if err != nil || next.Token == held.Token || w.renewals != 2 {
		t.Fatalf("Newer: %q %v renewals=%d", next.Token, err, w.renewals)
	}
	// With nothing newer and nothing unanswered, the sign-in is over.
	if _, err := k.Newer(context.Background(), next.Token); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("Newer on a good answer: %v", err)
	}
}

func TestAJoinTheAccountRefusesSaysWhy(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	w.refuseDevice = true
	if _, err := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone"); !errors.Is(err, ErrNewDevice) {
		t.Fatalf("bad_device: %v", err)
	}
	w.refuseDevice, w.locked, w.code = false, true, "K7QM-2XPD"
	if _, err := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone"); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked: %v", err)
	}
}

func TestDoorsThatSayNoInTheirOwnWays(t *testing.T) {
	cases := []struct {
		name    string
		set     func(*world)
		want    error
		refused bool
	}{
		{"no door", func(w *world) { w.door404 = true }, ErrNoDoor, true},
		{"regrant", func(w *world) { w.regrant = true }, ErrRegrant, false},
		{"forgotten", func(w *world) { w.forgotten[macA], w.forgotten[macB] = true, true }, ErrDoorRefused, true},
		{"lies at finish", func(w *world) { w.liarFinish = true }, ErrWrongMachine, true},
		{"a watch's token", func(w *world) { w.watchScope = true }, ErrDoorRefused, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := newWorld(t)
			reg := w.registry()
			state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
			c.set(w)
			next, outcomes, err := EnterAll(context.Background(), reg, state, RelayRoad(reg))
			if err != nil {
				t.Fatal(err)
			}
			o := outcomes[1]
			if !errors.Is(o.Err, c.want) || Refused(o) != c.refused {
				t.Fatalf("%+v: want %v refused=%v", o, c.want, c.refused)
			}
			if _, kept := next.Machines[macB]; kept {
				t.Fatal("kept a token from a door that said no")
			}
		})
	}
}

func TestTheRelaySigningThePhoneOutStopsEveryMachine(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.relayEnds = macA
	if _, outcomes, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); !errors.Is(err, ErrSignedOut) || len(outcomes) != 1 {
		t.Fatalf("relay 401: %v after %d outcomes", err, len(outcomes))
	}
}

func TestTheRegistryClientNeverFollowsARedirectWithTheSession(t *testing.T) {
	var heard []string
	elsewhere := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		heard = append(heard, r.Header.Get("Authorization"))
	}))
	defer elsewhere.Close()
	moved := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer moved.Close()
	reg, _ := NewRegistry(moved.URL, nil)
	if _, err := reg.PhonePass(context.Background(), "the-session"); err == nil {
		t.Fatal("a redirect read as a pass")
	}
	if len(heard) != 0 {
		t.Fatalf("followed the redirect with %v", heard)
	}
}

func TestAPhoneNotKeptYetIsToldToWaitForItsMac(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.awaitingKeep = true
	if _, _, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); !errors.Is(err, ErrAwaitingKeep) {
		t.Fatalf("not kept yet: %v", err)
	}
	if len(w.entered) != 0 {
		t.Fatal("knocked on a door before the phone was kept")
	}
	w.awaitingKeep = false
	if next, _, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); err != nil || len(next.Machines) != 2 {
		t.Fatalf("kept: %v, %d machines", err, len(next.Machines))
	}
}

func TestMatchCodeAndJoinProofAreTheRegistrysOwn(t *testing.T) {
	// tests/fixtures/phone-contract/account-vectors.json, its first key; tests/phone-keep-registry.test.ts pins the same.
	jwk := account.JWK{Kty: "OKP", Crv: "Ed25519", X: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"}
	if got, err := MatchCode(jwk); err != nil || got != "532815" {
		t.Fatalf("MatchCode = %q, %v", got, err)
	}
	if got := JoinProofMessage("K7QM-2XPD", "EAD074E4-96B9-8ED9-9E02-2CA7BBE51D5A"); got != "cookrew-join/1 K7QM-2XPD ead074e4-96b9-8ed9-9e02-2ca7bbe51d5a" {
		t.Fatalf("JoinProofMessage = %q", got)
	}
}

func TestAPhoneShowsItsMatchBeforeItJoins(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	key, _ := account.NewKey()
	device, _ := NewDevice(key, "iPhone")
	want, _ := device.Match()
	state, err := JoinWithKey(context.Background(), reg, "K7QM-2XPD", device)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := state.Device()
	if got, _ := again.Match(); got != want || again.ID != device.ID {
		t.Fatalf("joined as %s (%s), showed %s", again.ID, got, want)
	}
}

func TestAPhoneWaitingForKeepIsNotTakenForSignedOut(t *testing.T) {
	w := newWorld(t)
	reg := w.registry()
	state, _ := JoinAccount(context.Background(), reg, "K7QM-2XPD", "iPhone")
	w.awaitingKeep = true
	// The desktops answer 401 to a phone not kept yet; asking for the pass says why.
	if _, _, err := EnterAll(context.Background(), reg, state, RelayRoad(reg)); !errors.Is(err, ErrAwaitingKeep) {
		t.Fatalf("waiting: %v", err)
	}
}
