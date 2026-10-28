package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"testing"

	"golang.org/x/crypto/ssh"
)

func fakeKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	// Ephemeral, in-memory test keys only; never load an account's SSH files.
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("Could not generate test key")
	}
	t.Cleanup(func() { clear(private) })
	return private
}

func TestGenerateAndImportRoundTripInMemory(t *testing.T) {
	generated, code := generateKey()
	if code != "" || !generated.OK || len(generated.PrivateKey) == 0 {
		t.Fatal("Generation failed")
	}
	defer clear(generated.PrivateKey)
	imported, code := importKey(generated.PrivateKey, nil, false)
	if code != "" || imported.PublicKey != generated.PublicKey {
		t.Fatal("Normalization changed the public key")
	}
	defer clear(imported.PrivateKey)
	parsed, code := parseKey(imported.PrivateKey, nil, false)
	if code != "" {
		t.Fatal("Normalized key could not be parsed")
	}
	defer wipeKey(parsed)
	if _, ok := parsed.(ed25519.PrivateKey); !ok {
		t.Fatal("Generation did not produce Ed25519")
	}
}

func TestEncryptedImportAndRejection(t *testing.T) {
	private := fakeKey(t)
	passphrase := []byte("offline-fixture-passphrase")
	defer clear(passphrase)
	block, err := ssh.MarshalPrivateKeyWithPassphrase(private, "offline fixture", passphrase)
	if err != nil {
		t.Fatal("Could not create encrypted test key")
	}
	defer clear(block.Bytes)
	encoded := pem.EncodeToMemory(block)
	defer clear(encoded)
	if _, code := importKey(encoded, nil, false); code == "" {
		t.Fatal("Encrypted key accepted without passphrase")
	}
	if _, code := importKey(encoded, []byte("wrong-offline-passphrase"), true); code == "" {
		t.Fatal("Encrypted key accepted with wrong passphrase")
	}
	imported, code := importKey(encoded, passphrase, true)
	if code != "" {
		t.Fatal("Encrypted import failed")
	}
	defer clear(imported.PrivateKey)
	if bytes.Equal(encoded, imported.PrivateKey) {
		t.Fatal("Encrypted input was not normalized")
	}
	key, code := parseKey(imported.PrivateKey, nil, false)
	if code != "" {
		t.Fatal("Normalized key still needs an import passphrase")
	}
	wipeKey(key)
}

func TestImportRejectsAmbiguousAndInconsistentKeys(t *testing.T) {
	private := fakeKey(t)
	value, code := keyResponse(private)
	if code != "" {
		t.Fatal("Could not serialize test key")
	}
	defer clear(value.PrivateKey)
	for _, input := range [][]byte{
		nil, []byte("not-a-key"), []byte(value.PublicKey),
		append(append([]byte{}, value.PrivateKey...), value.PrivateKey...),
		append(append([]byte{}, value.PrivateKey...), []byte("trailing text")...),
	} {
		if _, code := importKey(input, nil, false); code == "" {
			t.Fatal("Malformed or ambiguous key accepted")
		}
	}
	inconsistent := append(ed25519.PrivateKey{}, private...)
	defer clear(inconsistent)
	inconsistent[len(inconsistent)-1] ^= 1
	if validPrivateKey(inconsistent) {
		t.Fatal("Inconsistent Ed25519 public/private halves accepted")
	}
}
