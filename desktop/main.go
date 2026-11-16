// Command desktop is Cookrew's native Mac window (Asuka): a client of the
// Cookrew running on this Mac, through its own API on loopback, as the phone
// is one through the relay. D2 of docs/desktop-native-migration-2026-11-16.
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
