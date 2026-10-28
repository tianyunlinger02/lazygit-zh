//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

func TestLinuxSecurePathChecksOwnershipModeAndLinks(t *testing.T) {
	for _, verifyOnly := range []bool{false, true} {
		name := "default"
		if verifyOnly {
			name = "verify-only"
		}
		t.Run(name, func(t *testing.T) {
			directory := shortTestDirectory(t)
			if code := securePath(directory, true, verifyOnly); code != "" {
				t.Fatalf("Private test directory refused: %s", code)
			}
			file := filepath.Join(directory, "empty-fixture")
			if os.WriteFile(file, nil, 0600) != nil {
				t.Fatal("Could not create empty test fixture")
			}
			if code := securePath(file, false, verifyOnly); code != "" {
				t.Fatal("Private test file refused")
			}
			if code := securePath(file, true, verifyOnly); code == "" {
				t.Fatal("File accepted as a directory")
			}
			if os.Chmod(file, 0644) != nil {
				t.Fatal("Could not change fixture mode")
			}
			if code := securePath(file, false, verifyOnly); code == "" {
				t.Fatal("World-readable file accepted")
			}
			if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0644 {
				t.Fatal("Rejected path check changed the file mode")
			}
			link := filepath.Join(directory, "link")
			if os.Symlink(file, link) != nil {
				t.Fatal("Could not create test symlink")
			}
			if code := securePath(link, false, verifyOnly); code == "" {
				t.Fatal("Final symlink accepted")
			}
			hardlink := filepath.Join(directory, "hardlink")
			if os.Chmod(file, 0600) != nil || os.Link(file, hardlink) != nil {
				t.Fatal("Could not create private hard-link fixture")
			}
			if code := securePath(file, false, verifyOnly); code == "" {
				t.Fatal("Multiply linked file accepted")
			}
			child := filepath.Join(directory, "child")
			if os.Mkdir(child, 0700) != nil || os.Chmod(child, 0700) != nil {
				t.Fatal("Could not create child directory")
			}
			middle := filepath.Join(directory, "middle")
			if os.Symlink(child, middle) != nil {
				t.Fatal("Could not create intermediate symlink")
			}
			if code := securePath(filepath.Join(middle, "missing"), false, verifyOnly); code == "" {
				t.Fatal("Intermediate symlink accepted")
			}
			if _, code := listenAgent(file); code == "" {
				t.Fatal("Existing file was replaced by agent")
			}
			if os.Chmod(directory, 0755) != nil {
				t.Fatal("Could not change test directory mode")
			}
			if _, code := listenAgent(filepath.Join(directory, "not-created")); code == "" {
				t.Fatal("Nonprivate socket parent accepted")
			}
		})
	}
}

func TestLinuxAgentReadySignAndParentEOFCleanup(t *testing.T) {
	directory := shortTestDirectory(t)
	endpoint := filepath.Join(directory, "s")
	key, code := keyResponse(fakeKey(t))
	if code != "" {
		t.Fatal("Could not encode test key")
	}
	defer clear(key.PrivateKey)
	requestLine, err := json.Marshal(struct {
		Protocol   int    `json:"protocol"`
		PrivateKey []byte `json:"privateKey"`
		Endpoint   string `json:"endpoint"`
	}{1, key.PrivateKey, endpoint})
	if err != nil {
		t.Fatal("Could not encode test request")
	}
	requestLine = append(requestLine, '\n')
	defer clear(requestLine)
	parentInput, parent := io.Pipe()
	output, helperOutput := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, parentInput, helperOutput, []string{"agent"}); helperOutput.Close() }()
	defer func() { cancel(); parent.Close(); output.Close(); parentInput.Close() }()
	if _, err := parent.Write(requestLine); err != nil {
		t.Fatal("Agent request write failed")
	}
	ready := make(chan response, 1)
	go func() { var value response; _ = json.NewDecoder(output).Decode(&value); ready <- value }()
	select {
	case value := <-ready:
		if !value.OK || value.Endpoint != endpoint || value.PublicKey != key.PublicKey || len(value.PrivateKey) != 0 {
			t.Fatal("Invalid ready response")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Agent ready timed out")
	}
	connection, err := net.DialTimeout("unix", endpoint, 2*time.Second)
	if err != nil {
		t.Fatal("Could not connect to test agent")
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	client := agent.NewClient(connection)
	keys, err := client.List()
	if err != nil || len(keys) != 1 {
		t.Fatal("Live agent did not list exactly one key")
	}
	public, err := ssh.ParsePublicKey(keys[0].Blob)
	if err != nil {
		t.Fatal("Live agent returned an invalid public key")
	}
	message := []byte("offline-integration-message")
	signature, err := client.Sign(public, message)
	if err != nil || public.Verify(message, signature) != nil {
		t.Fatal("Live agent signature failed")
	}
	if client.RemoveAll() == nil {
		t.Fatal("Live agent accepted mutation")
	}
	if _, err := parent.Write([]byte("parent-lifetime-data")); err != nil {
		t.Fatal("Lifetime channel was not consumed")
	}
	parent.Close()
	select {
	case exit := <-done:
		if exit != 0 {
			t.Fatal("Agent EOF exit was not protocol success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Agent did not exit on parent EOF")
	}
	if _, err := os.Lstat(endpoint); !os.IsNotExist(err) {
		t.Fatal("Socket was not removed after EOF")
	}
	var probe [1]byte
	if _, err := connection.Read(probe[:]); err == nil {
		t.Fatal("Existing connection remained open after EOF")
	}
	remaining, _ := io.ReadAll(output)
	if len(bytes.TrimSpace(remaining)) != 0 {
		t.Fatal("Agent emitted additional protocol output after ready")
	}
}
