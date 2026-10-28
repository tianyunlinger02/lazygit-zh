package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"math/big"
	"strings"

	"golang.org/x/crypto/ssh"
)

func generateKey() (response, failure) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return response{}, unavailable
	}
	defer clear(private)
	return keyResponse(private)
}

// Only a single PEM private key is accepted: no leading text, trailing keys,
// public-only files, certificates, hardware-backed keys, or weak DSA/RSA keys.
func parseKey(data, passphrase []byte, encrypted bool) (any, failure) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || len(trimmed) > maxKeyBytes || !bytes.HasPrefix(trimmed, []byte("-----BEGIN ")) {
		return nil, invalid
	}
	block, rest := pem.Decode(trimmed)
	if block == nil || len(bytes.TrimSpace(rest)) != 0 {
		return nil, invalid
	}
	defer clear(block.Bytes)
	if block.Type != "OPENSSH PRIVATE KEY" && block.Type != "PRIVATE KEY" && block.Type != "RSA PRIVATE KEY" && block.Type != "EC PRIVATE KEY" {
		return nil, unsupported
	}
	var key any
	var err error
	if encrypted {
		key, err = ssh.ParseRawPrivateKeyWithPassphrase(trimmed, passphrase)
	} else {
		key, err = ssh.ParseRawPrivateKey(trimmed)
	}
	if err != nil {
		return nil, denied
	}
	// ParseRawPrivateKey returns *ed25519.PrivateKey for OpenSSH keys.
	if pointer, ok := key.(*ed25519.PrivateKey); ok {
		key = *pointer
	}
	if !validPrivateKey(key) {
		wipeKey(key)
		return nil, unsupported
	}
	return key, ""
}

func validPrivateKey(key any) bool {
	switch k := key.(type) {
	case ed25519.PrivateKey:
		if len(k) != ed25519.PrivateKeySize {
			return false
		}
		canonical := ed25519.NewKeyFromSeed(k[:ed25519.SeedSize])
		defer clear(canonical)
		return bytes.Equal(k, canonical)
	case *rsa.PrivateKey:
		return k.N != nil && k.N.BitLen() >= 2048 && k.N.BitLen() <= 16384 && k.Validate() == nil
	case *ecdsa.PrivateKey:
		if k.Curve != elliptic.P256() && k.Curve != elliptic.P384() && k.Curve != elliptic.P521() {
			return false
		}
		if k.D == nil || k.X == nil || k.Y == nil || k.D.Sign() <= 0 || k.D.Cmp(k.Params().N) >= 0 || !k.Curve.IsOnCurve(k.X, k.Y) {
			return false
		}
		x, y := k.Curve.ScalarBaseMult(k.D.Bytes())
		return x.Cmp(k.X) == 0 && y.Cmp(k.Y) == 0
	}
	return false
}

func keyResponse(key any) (response, failure) {
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		return response{}, unsupported
	}
	block, err := ssh.MarshalPrivateKey(key, "AutoGit")
	if err != nil {
		return response{}, unsupported
	}
	defer clear(block.Bytes)
	encoded := pem.EncodeToMemory(block)
	if len(encoded) == 0 || len(encoded) > maxKeyBytes {
		clear(encoded)
		return response{}, invalid
	}
	value := success()
	value.PrivateKey = encoded
	value.PublicKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	return value, ""
}

func importKey(data, passphrase []byte, encrypted bool) (response, failure) {
	key, code := parseKey(data, passphrase, encrypted)
	if code != "" {
		return response{}, code
	}
	defer wipeKey(key)
	return keyResponse(key)
}

// Best-effort zeroing only. Go and cryptographic libraries can retain copies;
// the helper does not claim locked-memory or forensic-erasure guarantees.
func wipeInteger(value *big.Int) {
	if value != nil {
		clear(value.Bits())
		value.SetInt64(0)
	}
}
func wipeKey(key any) {
	switch k := key.(type) {
	case ed25519.PrivateKey:
		clear(k)
	case *ed25519.PrivateKey:
		clear(*k)
	case *ecdsa.PrivateKey:
		wipeInteger(k.D)
	case *rsa.PrivateKey:
		wipeInteger(k.D)
		for _, prime := range k.Primes {
			wipeInteger(prime)
		}
		wipeInteger(k.Precomputed.Dp)
		wipeInteger(k.Precomputed.Dq)
		wipeInteger(k.Precomputed.Qinv)
		for _, value := range k.Precomputed.CRTValues {
			wipeInteger(value.Exp)
			wipeInteger(value.Coeff)
			wipeInteger(value.R)
		}
	}
}
