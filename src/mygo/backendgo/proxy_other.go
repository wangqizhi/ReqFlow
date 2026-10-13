//go:build !windows

package backendgo

import (
	"net/url"
)

func desktopSystemProxy(scheme string) (*url.URL, error) { return nil, nil }
