package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/cookrew/cookrew-app/phone/core/live"
	"github.com/cookrew/cookrew-app/phone/term"
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// scrollback is how much history the local screen keeps.
const scrollback = 5000

// terminals is the native module's directory, made once.
var terminals = sync.OnceValues(term.NewTerminals)

// screens numbers the terminals this app opens: each AgentScreen has its own
// emulator, so two screens of one agent never feed the same one twice.
var screens atomic.Int64

func screenKey(agentID string) string {
	return fmt.Sprintf("%s-%d", agentID, screens.Add(1))
}

// AgentScreen is one agent's live terminal: its pane's bytes, followed on a
// goroutine and fed to the native screen, never through a signal.
func AgentScreen(store *Store, id string) ui.Node {
	dir, err := terminals()
	if err != nil {
		return notice("This Mac build has no terminal view: " + err.Error())
	}
	key := screenKey(id)
	screen, err := dir.Open(key, 80, 24, scrollback)
	if err != nil {
		return notice("The terminal could not open: " + err.Error())
	}
	link := signal.New("connecting…")
	said := signal.New("")
	held := signal.New(false)
	ctx, cancel := context.WithCancel(context.Background())
	typist := newTypist(store.plane, id, func(msg string, isHeld bool) {
		ui.Post(func() {
			said.Set(msg)
			held.Set(isHeld)
		})
	})
	go follow(ctx, store, id, screen, link)
	signal.OnCleanup(func() {
		cancel()
		typist.stop()
		_ = screen.Close()
	})

	env := ui.UseEnvironment()
	agent := store.Agent(id)
	return ui.Column(ui.Style{Grow: 1},
		ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 8, Padding: ui.Symmetric(8, 14)},
			ui.View(ui.ViewProps{Style: ui.StyleFunc(func() ui.Style {
				return ui.Style{Width: ui.Pt(9), Height: ui.Pt(9), CornerRadius: 4.5, Background: phaseColor(agent.Get().Phase)}
			})}),
			ui.Text(signal.Func(func() string { return latestLine(agent.Get()) }), ui.Style{Font: fonts.Subheadline, Lines: 1, Shrink: 1}),
			ui.Text(signal.Func(func() string { return agent.Get().Task }), ui.Style{Font: fonts.Subheadline, Color: colors.SecondaryLabel, Lines: 1, Grow: 1, Shrink: 1}),
		),
		term.TerminalView(term.TerminalViewProps{
			ID:       key,
			FontSize: ui.Val(terminalFontSize),
			Theme: signal.Func(func() term.Theme {
				if env.Get().Dark {
					return nightTerminal
				}
				return paperTerminal
			}),
			OnInput: typist.typeBytes,
			Style:   ui.Style{Grow: 1},
		}),
		ui.Row(ui.Style{Gap: 12, Padding: ui.Symmetric(6, 14), Align: ui.AlignCenter},
			ui.Text(link, ui.Style{Font: fonts.Caption, Color: colors.SecondaryLabel, Lines: 1}),
			ui.Text(said, ui.Style{Font: fonts.Caption, Color: colors.Orange, Lines: 1, Grow: 1, Shrink: 1}),
			ui.Show(held, func() ui.Node {
				return ui.Button(ui.ButtonProps{Title: ui.Val("Type again"), OnPress: typist.resume})
			}),
		),
	)
}

// follow runs the pane's stream into screen until ctx ends, and says how the link stands.
func follow(ctx context.Context, store *Store, id string, screen live.Screen, link *signal.Signal[string]) {
	report := func(st live.Status) {
		text := describe(st)
		ui.Post(func() { link.Set(text) })
	}
	err := live.Follower{}.Follow(ctx, store.plane, id, screen, report)
	if ctx.Err() != nil {
		return
	}
	text := "ended: " + err.Error()
	if errors.Is(err, live.ErrExited) {
		text = "the terminal exited"
	}
	ui.Post(func() { link.Set(text) })
}

func describe(st live.Status) string {
	switch st.Phase {
	case live.Live:
		return fmt.Sprintf("live · %d×%d", st.Hello.Cols, st.Hello.Rows)
	case live.Retrying:
		return fmt.Sprintf("reconnecting in %s · %v", st.Wait, st.Err)
	default:
		return "connecting…"
	}
}

func notice(text string) ui.Node {
	return ui.Column(ui.Style{Grow: 1, Justify: ui.JustifyCenter, Align: ui.AlignCenter, Padding: ui.All(24)},
		ui.StaticText(text, ui.Style{Color: colors.SecondaryLabel, TextAlign: ui.TextCenter}))
}
