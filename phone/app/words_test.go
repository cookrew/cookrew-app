package main

import "testing"

func TestAgentCountSaysWhatNeedsTheOwner(t *testing.T) {
	cases := map[string]fleetWorkspace{
		"0 agents":                     {},
		"1 agent · on screen":          {State: "focused", Agents: []fleetAgent{{Phase: "idle"}}},
		"2 agents · 1 waiting for you": {Agents: []fleetAgent{{Phase: "waiting"}, {Phase: "thinking"}}},
	}
	for want, w := range cases {
		if got := agentCount(w); got != want {
			t.Errorf("agentCount = %q, want %q", got, want)
		}
	}
}

func TestAgentLineShowsTheReplyOnceThereIsOne(t *testing.T) {
	cases := []struct {
		agent fleetAgent
		want  string
	}{
		{fleetAgent{Phase: "thinking", Task: "fix the build\nand more"}, "Working · fix the build"},
		{fleetAgent{Phase: "replied", Task: "fix the build", Reply: "Done: the build is green"}, "Replied · Done: the build is green"},
		{fleetAgent{Phase: "idle"}, "Idle"},
		{fleetAgent{Phase: "newphase"}, "newphase"},
	}
	for _, c := range cases {
		if got := agentLine(c.agent); got != c.want {
			t.Errorf("agentLine(%+v) = %q, want %q", c.agent, got, c.want)
		}
	}
}

func TestWaitingNamesTheNumberToCheck(t *testing.T) {
	if got := waitingLine("119163"); got != "Waiting for your Mac: tap Keep on the one that showed the code, if it shows 119 163." {
		t.Fatalf("waitingLine = %q", got)
	}
	if got := waitingLine(""); got != "Waiting for your Mac: tap Keep on the one that showed the code." {
		t.Fatalf("no number: %q", got)
	}
}
