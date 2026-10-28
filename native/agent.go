package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const maxAgentPacket = 1 << 20

// This is deliberately not a keyring: there is no mutation path and no
// delegation to an ambient SSH_AUTH_SOCK or Windows OpenSSH service.
type restrictedAgent struct{ signer ssh.Signer }

var _ agent.ExtendedAgent = (*restrictedAgent)(nil)

func (a *restrictedAgent) List() ([]*agent.Key, error) {
	public := a.signer.PublicKey()
	return []*agent.Key{{Format: public.Type(), Blob: public.Marshal(), Comment: "AutoGit session"}}, nil
}
func (a *restrictedAgent) Sign(key ssh.PublicKey, data []byte) (*ssh.Signature, error) {
	return a.SignWithFlags(key, data, 0)
}
func (a *restrictedAgent) SignWithFlags(key ssh.PublicKey, data []byte, flags agent.SignatureFlags) (*ssh.Signature, error) {
	if key == nil || !bytes.Equal(key.Marshal(), a.signer.PublicKey().Marshal()) || len(data) > maxAgentPacket {
		return nil, denied
	}
	if flags == 0 {
		return a.signer.Sign(rand.Reader, data)
	}
	if key.Type() != ssh.KeyAlgoRSA {
		return nil, denied
	}
	var algorithm string
	switch flags {
	case agent.SignatureFlagRsaSha256:
		algorithm = ssh.KeyAlgoRSASHA256
	case agent.SignatureFlagRsaSha512:
		algorithm = ssh.KeyAlgoRSASHA512
	default:
		return nil, denied
	}
	signer, ok := a.signer.(ssh.AlgorithmSigner)
	if !ok {
		return nil, denied
	}
	return signer.SignWithAlgorithm(rand.Reader, data, algorithm)
}
func (*restrictedAgent) Add(agent.AddedKey) error       { return denied }
func (*restrictedAgent) Remove(ssh.PublicKey) error     { return denied }
func (*restrictedAgent) RemoveAll() error               { return denied }
func (*restrictedAgent) Lock([]byte) error              { return denied }
func (*restrictedAgent) Unlock([]byte) error            { return denied }
func (*restrictedAgent) Signers() ([]ssh.Signer, error) { return nil, denied }
func (*restrictedAgent) Extension(string, []byte) ([]byte, error) {
	return nil, agent.ErrExtensionUnsupported
}

// Bound packets before the mature agent parser allocates them. Only List (11)
// and Sign/SignWithFlags (13) ever reach it; all mutation and extension frames
// receive SSH_AGENT_FAILURE, without parsing incoming private-key material.
type restrictedStream struct {
	net.Conn
	pending []byte
}

func (s *restrictedStream) Read(target []byte) (int, error) {
	if len(target) == 0 {
		return 0, nil
	}
	for len(s.pending) == 0 {
		var header [4]byte
		if _, err := io.ReadFull(s.Conn, header[:]); err != nil {
			return 0, err
		}
		n := binary.BigEndian.Uint32(header[:])
		if n == 0 || n > maxAgentPacket {
			return 0, denied
		}
		packet := make([]byte, 4+int(n))
		copy(packet, header[:])
		if _, err := io.ReadFull(s.Conn, packet[4:]); err != nil {
			clear(packet)
			return 0, err
		}
		if packet[4] != 11 && packet[4] != 13 {
			clear(packet)
			if err := writeAll(s.Conn, []byte{0, 0, 0, 1, 5}); err != nil {
				return 0, err
			}
			continue
		}
		s.pending = packet
	}
	n := copy(target, s.pending)
	clear(s.pending[:n])
	s.pending = s.pending[n:]
	return n, nil
}
func writeAll(out io.Writer, value []byte) error {
	for len(value) > 0 {
		n, err := out.Write(value)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		value = value[n:]
	}
	return nil
}

func runAgent(ctx context.Context, in io.Reader, out io.Writer, req *request) int {
	fail := func(code failure) int {
		if writeResponse(out, failed(code)) != nil {
			return 1
		}
		return 0
	}
	key, code := parseKey(req.PrivateKey, nil, false)
	clear(req.PrivateKey)
	req.PrivateKey = nil
	if code != "" {
		return fail(code)
	}
	defer wipeKey(key)
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		return fail(unsupported)
	}
	listener, code := listenAgent(req.Endpoint)
	if code != "" {
		return fail(code)
	}
	defer listener.Close()
	value := success()
	value.Endpoint = req.Endpoint
	value.PublicKey = string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if writeResponse(out, value) != nil {
		return 1
	}
	serveAgentSession(ctx, in, listener, &restrictedAgent{signer: signer})
	return 0
}

func serveAgentSession(ctx context.Context, in io.Reader, listener net.Listener, key *restrictedAgent) {
	parentEOF := make(chan struct{})
	go func() {
		defer close(parentEOF)
		buffer := make([]byte, 8192)
		defer clear(buffer)
		for {
			if _, err := in.Read(buffer); err != nil {
				return
			}
		}
	}()
	var mu sync.Mutex
	connections := make(map[net.Conn]bool)
	closing := false
	var workers sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			if closing || len(connections) >= 16 {
				mu.Unlock()
				connection.Close()
				continue
			}
			connections[connection] = true
			workers.Add(1)
			mu.Unlock()
			go func() {
				defer workers.Done()
				defer connection.Close()
				stream := &restrictedStream{Conn: connection}
				defer func() {
					clear(stream.pending)
					mu.Lock()
					delete(connections, connection)
					mu.Unlock()
					_ = recover() // no stack or request material in diagnostics
				}()
				_ = connection.SetDeadline(time.Now().Add(24 * time.Hour))
				_ = agent.ServeAgent(key, stream)
			}()
		}
	}()
	select {
	case <-parentEOF:
	case <-ctx.Done():
	case <-acceptDone:
	}
	mu.Lock()
	closing = true
	for connection := range connections {
		_ = connection.Close()
	}
	mu.Unlock()
	_ = listener.Close()
	<-acceptDone
	workers.Wait()
}
