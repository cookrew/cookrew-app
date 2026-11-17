// Package sse reads a machine's server-sent events (src/main/mobile-http.ts ·
// startSse): `event: <name>\ndata: <json>\n\n`, a `:ok` comment first, and a
// named `hb` event every ten seconds that a reader times to tell a dead road
// from a quiet one.
package sse

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
	"time"
)

// Heartbeat is the event a machine sends every HeartbeatEvery (SSE_HEARTBEAT_FRAME).
const (
	Heartbeat      = "hb"
	HeartbeatEvery = 10 * time.Second
	// DeadAfter is the silence after which a stream is dead whatever its socket says:
	// three beats missed and a little slack (renderer stream-watch.ts reasons the same way).
	DeadAfter = 35 * time.Second
)

// MaxLine bounds one line. A terminal replay frame is one JSON string on one
// data line, so this is generous; a longer line ends the stream with an error.
const MaxLine = 16 << 20

// ErrLineTooLong is returned for a line over MaxLine.
var ErrLineTooLong = errors.New("sse: a line is longer than MaxLine")

// Event is one dispatched event. Type is "message" when the frame named none.
// ID is the stream's last event id, which carries over events that name none.
type Event struct {
	Type string
	Data string
	ID   string
}

// parser holds one stream's state between lines. It is local to one Read.
type parser struct {
	typ    string
	data   []string
	lastID string
}

// line takes one line and answers the event it dispatches, if any.
func (p *parser) line(text []byte) (Event, bool) {
	if len(text) == 0 {
		return p.dispatch()
	}
	if text[0] == ':' {
		return Event{}, false // a comment (:ok)
	}
	field, value, found := bytes.Cut(text, []byte(":"))
	if found && len(value) > 0 && value[0] == ' ' {
		value = value[1:]
	}
	switch string(field) {
	case "event":
		p.typ = string(value)
	case "data":
		p.data = append(p.data, string(value))
	case "id":
		if !bytes.ContainsRune(value, 0) {
			p.lastID = string(value)
		}
	}
	// retry: and unknown fields are not ours to act on.
	return Event{}, false
}

// dispatch ends a frame. A frame with no data dispatches nothing, as EventSource does.
func (p *parser) dispatch() (Event, bool) {
	defer func() { p.typ, p.data = "", nil }()
	if len(p.data) == 0 {
		return Event{}, false
	}
	typ := p.typ
	if typ == "" {
		typ = "message"
	}
	return Event{Type: typ, Data: strings.Join(p.data, "\n"), ID: p.lastID}, true
}

// Read reads events from r and hands each to emit until r ends, emit returns
// an error, or a line is too long. Lines end in \n or \r\n.
func Read(r io.Reader, emit func(Event) error) error {
	reader := bufio.NewReaderSize(r, 64*1024)
	p := parser{}
	for {
		text, err := readLine(reader)
		if err != nil {
			return err
		}
		if event, ok := p.line(text); ok {
			if emitErr := emit(event); emitErr != nil {
				return emitErr
			}
		}
	}
}

func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > MaxLine {
			return nil, ErrLineTooLong
		}
		if err == nil {
			return bytes.TrimSuffix(bytes.TrimSuffix(line, []byte("\n")), []byte("\r")), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}
