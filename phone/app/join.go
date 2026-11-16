package main

import (
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/sdk/camera"
	"github.com/egoist/asuka/sdk/scan"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// JoinScreen is the first thing the phone shows: the camera, looking for the
// QR a Mac shows under ⋯ → Phone app, and a field for its eight characters.
func JoinScreen(session *Session) ui.Node {
	typed := signal.New("")
	cameraFailed := signal.New("")
	found := func(code scan.Code) {
		// One code at a time: a QR held in view keeps being read.
		if !session.Busy.Peek() {
			session.Join(code.Value)
		}
	}
	return ui.SafeArea(ui.Style{Grow: 1, Padding: ui.All(20), Gap: 14},
		ui.StaticText("Add this phone", ui.Style{Font: fonts.Title2}),
		ui.StaticText("On your Mac, open ⋯ → Phone app and scan the code it shows.", ui.Style{Font: fonts.Subheadline, Color: colors.SecondaryLabel}),
		// The Mac asks to keep a phone by this number: the owner checks it is this one.
		ui.Text(signal.Func(func() string { return "This iPhone’s number: " + spaced(session.Match.Get()) }), ui.Style{Font: fonts.Headline}),
		ui.Show(signal.Func(func() bool { return cameraFailed.Get() == "" }), func() ui.Node {
			return camera.View(camera.ViewProps{
				Scan:    scan.Codes(found, scan.QR),
				OnError: func(message string) { cameraFailed.Set(message) },
				Style:   ui.Style{Grow: 1, CornerRadius: 16},
			})
		}, func() ui.Node {
			return ui.Text(cameraFailed, ui.Style{Grow: 1, Font: fonts.Footnote, Color: colors.SecondaryLabel})
		}),
		ui.TextField(ui.TextFieldProps{
			Value:          typed,
			Placeholder:    ui.Val("Or type the code: K7QM-2XPD"),
			Autocapitalize: ui.CapitalizeCharacters,
			Autocorrect:    ui.AutocorrectNo,
			ReturnKey:      ui.ReturnGo,
			OnSubmit:       func() { session.Join(typed.Peek()) },
		}),
		ui.Button(ui.ButtonProps{
			Title:    signal.Func(func() string { return map[bool]string{true: "Joining…", false: "Join"}[session.Busy.Get()] }),
			Variant:  ui.ButtonFilled,
			Disabled: session.Busy,
			OnPress:  func() { session.Join(typed.Peek()) },
		}),
		problem(session),
		// A key is still kept (the sign-in ended, or the account would not take it): the way to let it go.
		ui.Show(signal.Func(func() bool { return session.State.Get().Seed != "" }), func() ui.Node { return startOver(session) }),
	)
}
