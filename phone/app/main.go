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
	vault, err := newFaceVault()
	if err != nil {
		return notice(err.Error())
	}
	session, err := NewSession(vault)
	if err != nil {
		return notice(err.Error())
	}
	return ui.Dynamic(func() ui.Node {
		switch session.Phase.Get() {
		case Locked:
			return LockedScreen(session)
		case Joining:
			return JoinScreen(session)
		case Joined:
			return ui.Stack(func() ui.Node { return MachinesScreen(session) }, ui.ScreenOptions{Title: ui.Val("Machines"), LargeTitle: true})
		}
		return notice("Opening…")
	})
}

// LockedScreen is a kept key Face ID has not opened: try again, never a new code.
func LockedScreen(session *Session) ui.Node {
	return ui.SafeArea(ui.Style{Grow: 1, Justify: ui.JustifyCenter, Align: ui.AlignCenter, Gap: 16, Padding: ui.All(24)},
		ui.Symbol("faceid", ui.Style{Color: colors.SecondaryLabel}),
		ui.StaticText("Cookrew is locked", ui.Style{Font: fonts.Headline}),
		problem(session),
		ui.Button(ui.ButtonProps{Title: ui.Val("Open with Face ID"), Variant: ui.ButtonFilled, OnPress: session.Unlock}),
		startOver(session),
	)
}

// startOver forgets the kept key, once the person has said so: the one way a
// key is let go other than Face ID changing.
func startOver(session *Session) ui.Node {
	return ui.Button(ui.ButtonProps{
		Title:   ui.Val("Start over as a new phone"),
		Variant: ui.ButtonPlain,
		OnPress: func() {
			ui.Alert(ui.AlertProps{
				Title:   "Start over?",
				Message: "This iPhone forgets its Cookrew key and joins again with a new code. Remove the old one in Devices at cookrew.dev.",
				Actions: []ui.Action{
					{Title: ui.Val("Cancel"), Role: ui.ActionCancel},
					{Title: ui.Val("Start over"), Role: ui.ActionDestructive, OnPress: session.StartOver},
				},
			})
		},
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
