package main

import (
	"fmt"
	"time"

	"github.com/cookrew/cookrew-app/phone/term"
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/ops"
)

// Cookrew's own surfaces (agent cards, the terminal) wear its paper and
// night colors (renderer terminal-theme.ts); the rest is the system's.
var (
	paperTerminal = term.Theme{Background: "#FFFEF5", Foreground: "#2D2A20", Cursor: "#2D2A20"}
	nightTerminal = term.Theme{Background: "#1D1A14", Foreground: "#ECE5D3", Cursor: "#ECE5D3"}

	paperCard  = colors.Hex(0xFFFEF5)
	nightCard  = colors.Hex(0x26221A)
	paperInk   = colors.Hex(0x2D2A20)
	nightInk   = colors.Hex(0xECE5D3)
	paperFaint = colors.Hex(0x8A8370)
	nightFaint = colors.Hex(0x9C947F)
)

// terminalFontSize is the terminal's text at full size, as the desktop's xterm.
const terminalFontSize float32 = 13

// phaseColor is a phase's dot: the board's working / waiting / unread / done / offline.
func phaseColor(phase string) ops.Color {
	switch phase {
	case "thinking":
		return colors.Blue
	case "waiting":
		return colors.Orange
	case "replied":
		return colors.Green
	case "idle":
		return colors.Gray
	default:
		return colors.TertiaryLabel
	}
}

// phaseWord is a phase as the card says it.
func phaseWord(phase string) string {
	switch phase {
	case "thinking":
		return "working"
	case "waiting":
		return "needs you"
	case "replied":
		return "replied"
	case "idle":
		return "idle"
	default:
		return "offline"
	}
}

// since is how long ago ms (epoch) was, shortly: "4m", "2h", "3d".
func since(ms int64, now time.Time) string {
	if ms <= 0 {
		return ""
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
