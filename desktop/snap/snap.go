// Package snap is QA without a mouse: it pictures the app's own window into
// a PNG, and plays keys into it as the keyboard would. An app may always
// picture its own window and post events to it, so this needs neither Screen
// Recording nor Accessibility (which a shell under an agent pane lacks).
// The Mac only.
package snap

// Snap pictures the app's window and types into it.
//
//asuka:native
type Snap interface {
	// Window writes the key window (else the first visible one), its title
	// bar and toolbar included, to path as a PNG.
	//
	//asuka:mainthread
	Window(path string) error
	// Keys gives the window's terminal the keyboard, then sends it text as
	// key presses, one per character ("\r" is Return), through AppKit's
	// own event path: the input method and the view handle them as typed.
	//
	//asuka:mainthread
	Keys(text string) error
	// Wheel scrolls the mouse wheel over the window's terminal, lines up (or
	// down, when negative), as AppKit delivers a real one.
	//
	//asuka:mainthread
	Wheel(lines int) error
}
