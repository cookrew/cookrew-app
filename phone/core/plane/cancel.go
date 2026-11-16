package plane

import (
	"context"
	"io"
)

// cancelOnClose ends a one-shot call's deadline when its body is closed, not
// when Do returns: the caller still has the body to read.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// static is a fixed pair of credentials, for tests and the probe.
type static struct{ session, token string }

// StaticCredentials are credentials that never change.
func StaticCredentials(session, token string) Credentials { return static{session, token} }

func (s static) Session() string      { return s.session }
func (s static) MachineToken() string { return s.token }
