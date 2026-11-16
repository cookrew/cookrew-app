// Package term is a terminal that shows a Cookrew pane's bytes: SwiftTerm on
// iOS and macOS (swift/), nothing elsewhere yet.
//
// Bytes never travel as a view prop. Asuka's view props are signals, and a
// signal written twice within a frame shows only its last value, so a byte
// stream sent that way loses chunks. Bytes go through the module instead
// (Terminal.Feed), a direct call that is never coalesced, and the view takes
// only the ID of the terminal it shows (design: docs/phone-native-arch, §6).
//
// One terminal lives under an ID from Open until Close, whether or not a view
// shows it: a view that goes (a screen popped) and comes back finds the same
// screen, scrollback included.
package term

import (
	"io"

	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// Terminals finds a terminal by the ID its views show.
//
//asuka:native
type Terminals interface {
	// Open makes the terminal under id, cols by rows with scrollback lines of
	// history, or finds the one already open (and sizes it so).
	//
	//asuka:mainthread
	Open(id string, cols, rows, scrollback int) (Terminal, error)
}

// Terminal is one screen. Feed and Resize may be called from any goroutine:
// they are applied on the main thread in the order they were called.
//
//asuka:native
type Terminal interface {
	io.Closer
	// Feed hands the screen a pane's bytes, as the pane wrote them.
	Feed(data []byte) error
	// Resize sets the screen's grid to the pane's (a hello frame). It never
	// asks the pane to change: the grid follows the pane, not the window.
	Resize(cols, rows int) error
	// ScrollToBottom shows the newest lines.
	ScrollToBottom() error
}

// Theme is a terminal's colors, as #rrggbb.
type Theme struct {
	Background string
	Foreground string
	Cursor     string
}

// TerminalViewProps show the terminal under ID, scaled so its whole grid
// fits the view's width.
//
//asuka:view
type TerminalViewProps struct {
	// ID is the terminal's, as given to Open. Set once.
	ID string
	// FontSize is the largest the text is drawn at, in points; smaller when
	// the grid would not fit the view's width.
	FontSize signal.Accessor[float32]
	Theme    signal.Accessor[Theme]
	// OnInput is what the user typed, as the bytes a terminal sends for it
	// (keys, a paste, text the input method composed).
	OnInput func(data []byte)
	// OnTouch is the user using the view (a click, a key): what a resize
	// policy asks before it lets this view size the pane.
	OnTouch func()
	Style   ui.Style
}
