package main

import (
	"strconv"
	"strings"
)

// agentCount is a workspace's agents in a few words.
func agentCount(w fleetWorkspace) string {
	n := len(w.Agents)
	waiting := 0
	for _, a := range w.Agents {
		if a.Phase == "waiting" {
			waiting++
		}
	}
	line := strconv.Itoa(n) + " agent"
	if n != 1 {
		line += "s"
	}
	if waiting > 0 {
		line += " · " + strconv.Itoa(waiting) + " waiting for you"
	}
	if w.State == "focused" {
		line += " · on screen"
	}
	return line
}

// phaseWords are an agent's phases as a person reads them.
var phaseWords = map[string]string{
	"idle":     "Idle",
	"thinking": "Working",
	"waiting":  "Waiting for you",
	"replied":  "Replied",
	"offline":  "Offline",
}

// agentLine is an agent's phase and what it is on.
func agentLine(a fleetAgent) string {
	phase, ok := phaseWords[a.Phase]
	if !ok {
		phase = a.Phase
	}
	about := strings.TrimSpace(a.Task)
	if a.Phase == "replied" && strings.TrimSpace(a.Reply) != "" {
		about = strings.TrimSpace(a.Reply)
	}
	if about == "" {
		return phase
	}
	return phase + " · " + firstLine(about)
}

// firstLine is the text up to its first line break.
func firstLine(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	return line
}
