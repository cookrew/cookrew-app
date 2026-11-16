package plane

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
)

// callTimeout bounds a one-shot call; streams have none and end with their context.
const callTimeout = 20 * time.Second

// exchange sends req to url with header on client and checks the answer. A
// one-shot call has callTimeout to finish, its body included; a stream ends
// with ctx. road names the plane in errors.
func exchange(ctx context.Context, client *http.Client, url string, req Request, header http.Header, road string) (*http.Response, error) {
	if req.Stream {
		resp, err := send(ctx, client, url, req, header, road)
		if err != nil {
			return nil, err
		}
		return Check(resp)
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	resp, err := send(ctx, client, url, req, header, road)
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = cancelOnClose{ReadCloser: resp.Body, cancel: cancel}
	return Check(resp)
}

func send(ctx context.Context, client *http.Client, url string, req Request, header http.Header, road string) (*http.Response, error) {
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(req.Body))
	if err != nil {
		return nil, fmt.Errorf("plane: building %s %s: %w", method, req.Route, err)
	}
	httpReq.Header = header
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("plane: %s %s %s: %w", road, method, req.Route, err)
	}
	return resp, nil
}
