package pair

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/cookrew/cookrew-app/phone/core/account"
	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// Machine is this phone's standing on one machine: the token that machine
// handed it, kept until the machine forgets the phone or the account revokes it.
type Machine struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"`
	// Until is when the machine stops remembering the phone; 0 means until revoked.
	Until int64 `json:"until"`
}

var (
	// ErrNoDoor: the machine has no account door (signed out, or older than account pairing).
	ErrNoDoor = errors.New("pair: that machine has no door for the account")
	// ErrDoorRefused: the machine turned this phone away (forgotten there, an old machine that does not read a phone pass, a revoked pass).
	ErrDoorRefused = errors.New("pair: that machine turned this phone away")
	// ErrWrongMachine: a machine answered in another machine's name; nothing was signed or kept.
	ErrWrongMachine = errors.New("pair: a machine answered for a different machine")
)

type pairDevice struct {
	DeviceID string      `json:"deviceId"`
	JWK      account.JWK `json:"jwk"`
	Name     string      `json:"name"`
}

type pairAnswer struct {
	OK        bool   `json:"ok"`
	Outcome   string `json:"outcome"`
	DeviceID  string `json:"deviceId"`
	DesktopID string `json:"desktopId"`
	Token     string `json:"token"`
	Until     int64  `json:"until"`
	Scope     string `json:"scope"`
	Error     string `json:"error"`
}

// maxAnswer bounds a door's answer.
const maxAnswer = 16 * 1024

// Enter takes the phone through one machine's door with the account's pass:
// a challenge, this key's signature over it, and the machine's token for this
// phone. The transcript names the machine, so the phone signs only for the one
// it meant (`machineID`): a machine passing on another's challenge would
// otherwise get that one's token with this phone's signature.
func Enter(ctx context.Context, road plane.Plane, device Device, pass Pass, machine Desktop) (Machine, error) {
	meant := strings.ToLower(machine.DeviceID)
	if !plane.IsMachineID(meant) {
		return Machine{}, fmt.Errorf("pair: %q is not a machine id", machine.DeviceID)
	}
	jwk, err := device.Key.JWK()
	if err != nil {
		return Machine{}, err
	}
	asking := pairDevice{DeviceID: device.ID, JWK: jwk, Name: device.Name}
	var challenge account.PairChallenge
	if err := post(ctx, road, "api/pair/begin", map[string]any{"device": asking, "grant": pass.Grant}, &challenge); err != nil {
		return Machine{}, err
	}
	if strings.ToLower(challenge.DesktopID) != meant {
		return Machine{}, ErrWrongMachine
	}
	transcript, err := account.PairTranscript(challenge, device.ID)
	if err != nil {
		return Machine{}, err
	}
	sig, err := device.Key.Sign(transcript)
	if err != nil {
		return Machine{}, err
	}
	var answer pairAnswer
	finish := map[string]any{"device": asking, "grant": pass.Grant, "challengeId": challenge.ChallengeID, "sig": sig}
	if err := post(ctx, road, "api/pair", finish, &answer); err != nil {
		return Machine{}, err
	}
	switch {
	case strings.ToLower(answer.DesktopID) != meant:
		return Machine{}, ErrWrongMachine
	// Only a device's token: a machine that answered with a watch's is not one this phone should hold.
	case !answer.OK || answer.Outcome != "admitted" || answer.Token == "" || answer.Scope != "" || answer.DeviceID != device.ID:
		return Machine{}, fmt.Errorf("%w: %s", ErrDoorRefused, answer.Error)
	}
	return Machine{ID: meant, Name: machine.Name, Token: answer.Token, Until: answer.Until}, nil
}

// post sends one JSON body to a machine route and decodes the 2xx answer.
func post(ctx context.Context, road plane.Plane, route string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("pair: encoding %s: %w", route, err)
	}
	resp, err := road.Do(ctx, plane.Request{Method: http.MethodPost, Route: route, Body: raw})
	if err != nil {
		return doorError(err)
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer))
	if err != nil {
		return fmt.Errorf("pair: reading %s: %w", route, err)
	}
	if err := json.Unmarshal(answer, out); err != nil {
		return fmt.Errorf("pair: decoding %s: %w", route, err)
	}
	return nil
}

// doorError names a plane's refusal as the door's: a 404 is no door at all.
func doorError(err error) error {
	var status *plane.StatusError
	switch {
	case errors.As(err, &status) && status.Status == http.StatusNotFound:
		return ErrNoDoor
	case errors.Is(err, plane.ErrRefused):
		return fmt.Errorf("%w: %v", ErrDoorRefused, err)
	}
	return err
}
