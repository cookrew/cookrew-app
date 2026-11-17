package main

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/cookrew/cookrew-app/phone/core/fleet"
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// AgentsScreen is one workspace's agents as cards, in the feed's order
// (creation order: attention is a highlight, never a sort).
func AgentsScreen(store *Store, workspaceID string) ui.Node {
	nav := ui.UseNavigator()
	agents := store.Agents(workspaceID)
	env := ui.UseEnvironment()
	open := func(a fleet.Agent) {
		agent := store.Agent(a.ID)
		nav.Push(func() ui.Node { return AgentScreen(store, a.ID) }, ui.ScreenOptions{
			Title: signal.Func(func() string { return agent.Get().Name }),
		})
	}
	if id := qaAgentOnce(); id != "" {
		for _, a := range signal.Untrack(agents.Get) {
			if a.ID == id {
				ui.Post(func() { open(a) }) // once this screen is up: never push during its own build
			}
		}
	}
	return ui.Scroll(ui.ScrollProps{Style: ui.Style{Grow: 1}},
		ui.Column(ui.Style{Padding: ui.All(20), Gap: 16},
			ui.Show(signal.Func(func() bool { return len(agents.Get()) == 0 }), func() ui.Node {
				return ui.StaticText("No agents in this workspace.", ui.Style{Color: colors.SecondaryLabel})
			}),
			ui.Row(ui.Style{Wrap: true, Gap: 14},
				ui.For(agents, func(a fleet.Agent) string { return a.ID }, func(agent signal.Accessor[fleet.Agent], _ signal.Accessor[int]) ui.Node {
					return AgentCard(store, agent, env, func() { open(signal.Untrack(agent.Get)) })
				}),
			),
		),
	)
}

// AgentCard is one agent, drawn as Cookrew draws it: its phase as a dot and a
// word, what it is on, and its latest line.
func AgentCard(store *Store, agent signal.Accessor[fleet.Agent], env signal.Accessor[ui.Environment], open func()) ui.Node {
	dark := func() bool { return env.Get().Dark }
	name := ui.StyleFunc(func() ui.Style {
		return ui.Style{Font: fonts.Headline, Color: pick(dark(), nightInk, paperInk), Lines: 1, Grow: 1, Shrink: 1}
	})
	faint := func(lines int) ui.Styler {
		return ui.StyleFunc(func() ui.Style {
			return ui.Style{Font: fonts.Footnote, Color: pick(dark(), nightFaint, paperFaint), Lines: lines}
		})
	}
	return ui.View(ui.ViewProps{
		OnPress: open,
		Label:   signal.Func(func() string { a := agent.Get(); return a.Name + ", " + phaseWord(a.Phase) }),
		Style: ui.StyleFunc(func() ui.Style {
			a := agent.Get()
			s := ui.Style{
				Width: ui.Pt(280), MinHeight: ui.Pt(132), Padding: ui.All(14), Gap: 8, CornerRadius: 14,
				Background:  pick(dark(), nightCard, paperCard),
				BorderWidth: 1, BorderColor: colors.Separator,
				Shadow: ui.Shadow{Color: colors.RGBA(0, 0, 0, 40), Radius: 6, Y: 2},
			}
			if a.Phase == "waiting" {
				s.BorderWidth = 2
				s.BorderColor = colors.Orange
			}
			return s
		}),
	},
		ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 8},
			ui.View(ui.ViewProps{Style: ui.StyleFunc(func() ui.Style {
				return ui.Style{Width: ui.Pt(9), Height: ui.Pt(9), CornerRadius: 4.5, Background: phaseColor(agent.Get().Phase)}
			})}),
			ui.Text(signal.Func(func() string { return agent.Get().Name }), name),
			ui.Text(signal.Func(func() string { return harnessLine(agent.Get()) }), faint(1)),
		),
		ui.Text(signal.Func(func() string { return taskLine(store, agent.Get()) }), faint(2)),
		ui.Text(signal.Func(func() string { return latestLine(agent.Get()) }), faint(2)),
	)
}

func pick[T any](dark bool, night, paper T) T {
	if dark {
		return night
	}
	return paper
}

func harnessLine(a fleet.Agent) string {
	if a.Model != "" {
		return a.Harness + " · " + a.Model
	}
	return a.Harness
}

// taskLine is what the agent is on, else the folder it works in.
func taskLine(store *Store, a fleet.Agent) string {
	if a.Task != "" {
		return a.Task
	}
	if entry, ok := store.Roster.Get()[a.ID]; ok && entry.Cwd != "" {
		return filepath.Base(entry.Cwd)
	}
	return ""
}

// latestLine is the phase and how long, then the live verb or the last reply.
func latestLine(a fleet.Agent) string {
	parts := []string{phaseWord(a.Phase)}
	if ago := since(a.PhaseSince, time.Now()); ago != "" {
		parts[0] += " " + ago
	}
	switch {
	case a.Phase == "thinking" && a.Status != "":
		parts = append(parts, a.Status)
	case a.Reply != "":
		parts = append(parts, a.Reply)
	}
	return strings.Join(parts, " · ")
}
