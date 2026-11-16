// Command desktop is Cookrew's native Mac window (Asuka): a client of the
// Cookrew running on this Mac, through its own API on loopback, as the phone
// is one through the relay. D2 of docs/desktop-native-migration-2026-11-16.
//
// Build (no Apple ID; signed ad hoc), from this directory:
//
//	asuka build --platform mac   # asuka CLI at go.mod's version (v0.1.1)
//
// It needs Xcode, and Xcode's Metal Toolchain, which Xcode does not install by
// itself: SwiftTerm (phone/term) compiles a Metal shader. Once per Mac:
//
//	xcodebuild -downloadComponent MetalToolchain
//
// Without it the build stops at "cannot execute tool 'metal' due to missing
// Metal Toolchain".
package main

import (
	"github.com/egoist/asuka/app"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

func main() {
	app.RunWindow(ui.WindowOptions{Width: 1180, Height: 760, MinWidth: 720, MinHeight: 460, StateKey: "main"}, App)
}

// App is the main window's content.
func App() ui.Node {
	startQA()
	p, err := connect()
	if err != nil {
		return notice(err.Error())
	}
	store, stop := NewStore(p)
	signal.OnCleanup(stop)
	return Root(store)
}
