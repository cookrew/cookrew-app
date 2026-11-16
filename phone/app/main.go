// Command app is Cookrew on the iPhone (Asuka): the phone joins the owner's
// account by a QR a Mac shows (⋯ → Phone app), is trusted until it is revoked,
// and reaches every Mac of the account through cookrew.dev's relay. Its logic
// is phone/core (pure Go); this is only what it looks like.
package main

import (
	"github.com/egoist/asuka/app"
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

func main() {
	app.Run(App)
}

// App is the whole interface: the scanner until the phone has joined, then
// the account's machines.
func App() ui.Node {
	session, err := NewSession(keychainVault{})
	if err != nil {
		return notice(err.Error())
	}
	return ui.Dynamic(func() ui.Node {
		switch session.Phase.Get() {
		case Joining:
			return JoinScreen(session)
		case Joined:
			return ui.Stack(func() ui.Node { return MachinesScreen(session) }, ui.ScreenOptions{Title: ui.Val("Machines"), LargeTitle: true})
		}
		return notice("Opening…")
	})
}

// notice is a screen with one sentence on it.
func notice(text string) ui.Node {
	return ui.SafeArea(ui.Style{Grow: 1, Justify: ui.JustifyCenter, Align: ui.AlignCenter, Padding: ui.All(24)},
		ui.StaticText(text, ui.Style{Font: fonts.Body, Color: colors.SecondaryLabel, TextAlign: ui.TextCenter}),
	)
}

// problem shows the session's last failure, when there is one.
func problem(session *Session) ui.Node {
	return ui.Show(signal.Func(func() bool { return session.Problem.Get() != "" }), func() ui.Node {
		return ui.Text(session.Problem, ui.Style{Font: fonts.Footnote, Color: colors.Red, TextAlign: ui.TextCenter, Lines: 4})
	})
}
