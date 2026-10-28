package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func decodeResponse(t *testing.T, data []byte) response {
	t.Helper()
	if bytes.Count(data, []byte{'\n'}) != 1 {
		t.Fatal("Expected exactly one JSON line")
	}
	var value response
	if json.Unmarshal(data, &value) != nil || value.Protocol != 1 {
		t.Fatal("Invalid protocol response")
	}
	return value
}

func TestProtocolFailuresAreExitZeroAndSanitized(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"generate-key", "extra"}} {
		var out bytes.Buffer
		if run(context.Background(), strings.NewReader("offline-fixture-input"), &out, args) != 0 {
			t.Fatal("Protocol response was not exit zero")
		}
		if value := decodeResponse(t, out.Bytes()); value.OK || value.Code != unsupported {
			t.Fatal("Unknown command was not refused")
		}
		if bytes.Contains(out.Bytes(), []byte("offline-fixture-input")) {
			t.Fatal("Failure leaked input")
		}
	}
}

type unreadableLoginInput struct{}

func (unreadableLoginInput) Read([]byte) (int, error) {
	panic("Retired OS-login commands must not read input")
}

func TestRetiredOSLoginCommandsAreRejectedWithoutReadingInput(t *testing.T) {
	for _, command := range []string{"identity", "authenticate"} {
		t.Run(command, func(t *testing.T) {
			var out bytes.Buffer
			if run(context.Background(), unreadableLoginInput{}, &out, []string{command}) != 0 {
				t.Fatal("Retired command did not return a protocol response")
			}
			if out.String() != "{\"ok\":false,\"protocol\":1,\"code\":\"unsupported\"}\n" {
				t.Fatal("Retired command exposed an identity or was not refused")
			}
		})
	}
}

func TestStrictBoundedProtocol(t *testing.T) {
	cases := []struct{ command, input string }{
		{"generate-key", `{"protocol":1,"protocol":1}`},
		{"generate-key", `{"protocol":1,"Protocol":1}`},
		{"generate-key", `{"protocol":1,"extra":true}`},
		{"generate-key", `{"protocol":1,"password":"offline-fixture"}`},
		{"generate-key", `{"protocol":2}`},
		{"generate-key", `{"protocol":1.0}`},
		{"generate-key", `[]`},
		{"generate-key", `null`},
		{"generate-key", `{"protocol":1} {"protocol":1}`},
		{"generate-key", `{"protocol":1}` + "\ntrailing"},
		{"import-key", `{"protocol":1,"privateKey":null}`},
		{"import-key", `{"protocol":1,"privateKey":"eA==","passphrase":null}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":null}`},
		{"secure-path", `{"protocol":1,"path":"/offline"}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":false,"verifyOnly":null}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":false,"verifyOnly":1}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":false,"verifyOnly":"true"}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":false,"verifyOnly":true,"verifyOnly":false}`},
		{"secure-path", `{"protocol":1,"path":"/offline","directory":false,"VerifyOnly":true}`},
	}
	for _, item := range cases {
		req, code := readRequest(bufio.NewReader(strings.NewReader(item.input+"\n")), item.command)
		req.wipe()
		if code == "" {
			t.Fatalf("Accepted malformed %s request", item.command)
		}
	}
	if _, code := readRequest(bufio.NewReader(strings.NewReader(strings.Repeat("x", maxRequestBytes+1))), "generate-key"); code == "" {
		t.Fatal("Accepted oversized request")
	}
	// Keep agent input after the ready line intact for the lifetime channel.
	input := bufio.NewReader(strings.NewReader(`{"protocol":1,"privateKey":"eA==","endpoint":"offline"}` + "\nparent-data"))
	req, code := readRequest(input, "agent")
	defer req.wipe()
	if code != "" {
		t.Fatal("Valid agent framing was rejected")
	}
	remaining, _ := input.ReadString('\n')
	if remaining != "parent-data" {
		t.Fatal("Agent lifetime input was consumed")
	}
}

func TestSecurePathVerifyOnlyProtocol(t *testing.T) {
	for _, item := range []struct {
		suffix string
		verify bool
	}{
		{"", false},
		{`,"verifyOnly":false`, false},
		{`,"verifyOnly":true`, true},
	} {
		input := `{"protocol":1,"path":"offline-fixture","directory":true` + item.suffix + "}\n"
		req, code := readRequest(bufio.NewReader(strings.NewReader(input)), "secure-path")
		if code != "" || req.Path != "offline-fixture" || !req.Directory || req.VerifyOnly != item.verify {
			t.Fatal("Secure-path verification mode was not preserved")
		}
	}
}

func TestCanonicalBase64AndKeyPassphraseLimits(t *testing.T) {
	for _, encoded := range []string{"YQ==\\n", "YR==", "YQ", " YQ==", "YQ== "} {
		_, err := decodeSecret(json.RawMessage(`"`+encoded+`"`), 8)
		if err == nil {
			t.Fatal("Accepted noncanonical base64")
		}
	}
	tooLong := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{'x'}, maxPassphraseBytes+1))
	req, code := readRequest(bufio.NewReader(strings.NewReader(`{"protocol":1,"privateKey":"eA==","passphrase":"`+tooLong+`"}`+"\n")), "import-key")
	req.wipe()
	if code != invalid {
		t.Fatal("Oversized key passphrase was not refused")
	}
	// Key passphrases are byte strings, not OS passwords or UTF-8 account data.
	secret := []byte{0, 255, 128, 1}
	defer clear(secret)
	encoded := base64.StdEncoding.EncodeToString(secret)
	req, code = readRequest(bufio.NewReader(strings.NewReader(`{"protocol":1,"privateKey":"eA==","passphrase":"`+encoded+`"}`+"\n")), "import-key")
	defer req.wipe()
	if code != "" || !req.HasPassphrase || !bytes.Equal(req.Passphrase, secret) {
		t.Fatal("Key passphrase framing changed secret bytes")
	}
	privateKey, passphrase := req.PrivateKey, req.Passphrase
	req.wipe()
	if !bytes.Equal(privateKey, make([]byte, len(privateKey))) || !bytes.Equal(passphrase, make([]byte, len(passphrase))) {
		t.Fatal("Request wipe did not clear private-key material")
	}
}

func TestKeyCommandsAreDispatchedWithoutLogin(t *testing.T) {
	var generated bytes.Buffer
	if run(context.Background(), strings.NewReader(`{"protocol":1}`), &generated, []string{"generate-key"}) != 0 {
		t.Fatal("Key generation did not return a protocol response")
	}
	defer clear(generated.Bytes())
	key := decodeResponse(t, generated.Bytes())
	defer clear(key.PrivateKey)
	if !key.OK || len(key.PrivateKey) == 0 || key.PublicKey == "" || bytes.Contains(generated.Bytes(), []byte(`"identity"`)) {
		t.Fatal("Key generation failed or exposed a protocol identity")
	}
	payload, err := json.Marshal(struct {
		Protocol   int    `json:"protocol"`
		PrivateKey []byte `json:"privateKey"`
	}{protocolVersion, key.PrivateKey})
	if err != nil {
		t.Fatal("Could not encode in-memory import request")
	}
	defer clear(payload)
	var imported bytes.Buffer
	if run(context.Background(), bytes.NewReader(payload), &imported, []string{"import-key"}) != 0 {
		t.Fatal("Key import did not return a protocol response")
	}
	defer clear(imported.Bytes())
	value := decodeResponse(t, imported.Bytes())
	defer clear(value.PrivateKey)
	if !value.OK || value.PublicKey != key.PublicKey || bytes.Contains(imported.Bytes(), []byte(`"identity"`)) {
		t.Fatal("Key import failed or exposed a protocol identity")
	}
}
