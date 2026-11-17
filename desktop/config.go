package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cookrew/cookrew-app/phone/core/plane"
)

// defaultOrigin is the running Cookrew's own API on this computer
// (mobile-server, plain http on loopback).
const defaultOrigin = "http://127.0.0.1:8639"

// tokenPath is where Cookrew keeps this computer's pairing token.
func tokenPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("finding the home folder: %w", err)
	}
	return filepath.Join(home, ".cookrew", "pairing-token"), nil
}

// maxToken bounds the file read: a token is a few dozen bytes.
const maxToken = 4096

// readToken reads the pairing token, the machine's Bearer for this computer.
func readToken(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading Cookrew's pairing token (%s): %w", path, err)
	}
	if len(raw) > maxToken {
		return "", fmt.Errorf("%s is not a pairing token (%d bytes)", path, len(raw))
	}
	token := strings.TrimSpace(string(raw))
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", errors.New("the pairing token file is empty or malformed: is Cookrew running?")
	}
	return token, nil
}

// connect is the plane to this computer's Cookrew: COOKREW_NATIVE_ORIGIN, or
// the default, which NewLoopback holds to loopback addresses.
func connect() (plane.Plane, error) {
	origin := os.Getenv("COOKREW_NATIVE_ORIGIN")
	if origin == "" {
		origin = defaultOrigin
	}
	path, err := tokenPath()
	if err != nil {
		return nil, err
	}
	token, err := readToken(path)
	if err != nil {
		return nil, err
	}
	// No account session: the loopback plane would not send one anyway.
	return plane.NewLoopback(origin, plane.StaticCredentials("", token), nil)
}
