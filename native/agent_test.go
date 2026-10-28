package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func TestRestrictedAgentOnlyListsAndSignsItsKey(t *testing.T) {
	private := fakeKey(t)
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal("Could not create test signer")
	}
	a := &restrictedAgent{signer: signer}
	keys, err := a.List()
	if err != nil || len(keys) != 1 {
		t.Fatal("Agent did not list exactly one key")
	}
	message := []byte("protocol-only test message")
	signature, err := a.Sign(signer.PublicKey(), message)
	if err != nil {
		t.Fatal("Signature failed")
	}
	if signer.PublicKey().Verify(message, signature) != nil {
		t.Fatal("Signature verification failed")
	}
	foreign, err := ssh.NewSignerFromKey(fakeKey(t))
	if err != nil {
		t.Fatal("Could not create foreign test signer")
	}
	if _, err := a.Sign(foreign.PublicKey(), message); err != denied {
		t.Fatal("Agent signed with a foreign key")
	}
	for _, err := range []error{
		a.Add(agent.AddedKey{PrivateKey: private}), a.Remove(signer.PublicKey()), a.RemoveAll(), a.Lock(nil), a.Unlock(nil),
	} {
		if err != denied {
			t.Fatal("Agent mutation was not denied")
		}
	}
	if _, err := a.Signers(); err != denied {
		t.Fatal("Agent exposed local signers")
	}
	if _, err := a.Extension("offline-fixture", nil); err != agent.ErrExtensionUnsupported {
		t.Fatal("Extension was accepted")
	}
	if _, err := a.SignWithFlags(signer.PublicKey(), message, agent.SignatureFlagReserved); err != denied {
		t.Fatal("Reserved signature flag was accepted")
	}
	if _, err := a.SignWithFlags(signer.PublicKey(), message, agent.SignatureFlagRsaSha512); err != denied {
		t.Fatal("RSA flag was accepted for Ed25519")
	}
}

func TestRestrictedAgentWireProtocol(t *testing.T) {
	private := fakeKey(t)
	signer, _ := ssh.NewSignerFromKey(private)
	server, connection := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer server.Close()
		_ = agent.ServeAgent(&restrictedAgent{signer: signer}, &restrictedStream{Conn: server})
	}()
	defer func() { connection.Close(); <-done }()
	client := agent.NewClient(connection)
	if err := client.Add(agent.AddedKey{PrivateKey: private}); err == nil {
		t.Fatal("Wire Add was accepted")
	}
	keys, err := client.List()
	if err != nil || len(keys) != 1 {
		t.Fatal("Wire List failed after rejected mutation")
	}
	message := []byte("offline-agent-signature")
	signature, err := client.SignWithFlags(signer.PublicKey(), message, 0)
	if err != nil || signer.PublicKey().Verify(message, signature) != nil {
		t.Fatal("Wire signature failed")
	}
	if client.RemoveAll() == nil || client.Lock([]byte("offline-lock")) == nil {
		t.Fatal("Wire mutation was accepted")
	}
}

func TestAgentPacketSizeLimit(t *testing.T) {
	server, connection := net.Pipe()
	done := make(chan error, 1)
	go func() {
		var one [1]byte
		_, err := (&restrictedStream{Conn: server}).Read(one[:])
		done <- err
		server.Close()
	}()
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], maxAgentPacket+1)
	if _, err := connection.Write(header[:]); err != nil {
		t.Fatal("Could not send oversized test header")
	}
	if err := <-done; err == nil {
		t.Fatal("Oversized packet was accepted")
	}
	connection.Close()
}

func TestRestrictedStreamDoesNotForwardMutationMaterial(t *testing.T) {
	server, connection := net.Pipe()
	done := make(chan []byte, 1)
	go func() {
		stream := &restrictedStream{Conn: server}
		var accepted [5]byte
		_, _ = io.ReadFull(stream, accepted[:])
		done <- accepted[:]
		server.Close()
	}()
	// Denied request then an allowed List request; denied payload is never
	// forwarded into the mature parser as private-key material.
	if writeAll(connection, []byte{0, 0, 0, 4, 17, 1, 2, 3}) != nil {
		t.Fatal("Write failed")
	}
	var failureReply [5]byte
	if _, err := io.ReadFull(connection, failureReply[:]); err != nil || !bytes.Equal(failureReply[:], []byte{0, 0, 0, 1, 5}) {
		t.Fatal("Denied mutation did not receive failure")
	}
	if writeAll(connection, []byte{0, 0, 0, 1, 11}) != nil {
		t.Fatal("List write failed")
	}
	if !bytes.Equal(<-done, []byte{0, 0, 0, 1, 11}) {
		t.Fatal("Only List should reach parser")
	}
	connection.Close()
}
