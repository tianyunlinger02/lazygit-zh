//go:build !linux && !windows

package main

import "net"

func currentIdentity() (identity, failure)       { return identity{}, unsupported }
func securePath(string, bool, bool) failure      { return unsupported }
func listenAgent(string) (net.Listener, failure) { return nil, unsupported }
