package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const (
	protocolVersion    = 1
	maxRequestBytes    = 2 << 20
	maxKeyBytes        = 1 << 20
	maxPassphraseBytes = 4096
)

type failure string

const (
	denied      failure = "denied"
	unavailable failure = "unavailable"
	unsupported failure = "unsupported"
	account     failure = "account"
	invalid     failure = "invalid"
)

func (f failure) Error() string { return string(f) }

type response struct {
	OK         bool    `json:"ok"`
	Protocol   int     `json:"protocol"`
	Code       failure `json:"code,omitempty"`
	PrivateKey []byte  `json:"privateKey,omitempty"`
	PublicKey  string  `json:"publicKey,omitempty"`
	Endpoint   string  `json:"endpoint,omitempty"`
}

func success() response            { return response{OK: true, Protocol: protocolVersion} }
func failed(code failure) response { return response{Protocol: protocolVersion, Code: code} }

// No raw OS, parser, or cryptographic error crosses the protocol boundary.
func writeResponse(out io.Writer, value response) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	defer clear(encoded)
	encoded = append(encoded, '\n')
	for len(encoded) != 0 {
		n, err := out.Write(encoded)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		encoded = encoded[n:]
	}
	return nil
}

type request struct {
	PrivateKey    []byte
	Passphrase    []byte
	HasPassphrase bool
	Endpoint      string
	Path          string
	Directory     bool
	VerifyOnly    bool
}

func (r *request) wipe() {
	clear(r.PrivateKey)
	clear(r.Passphrase)
}

// JSON is a single bounded line. One-shot commands also require EOF after it;
// the agent must leave stdin open as its lifetime channel.
func readRequest(in *bufio.Reader, command string) (request, failure) {
	var r request
	line := make([]byte, 0, 4096)
	defer func() { clear(line) }()
	newline := false
	for {
		part, err := in.ReadSlice('\n')
		if len(line)+len(part) > maxRequestBytes {
			return r, invalid
		}
		line = append(line, part...)
		if err == nil {
			newline = true
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			break
		}
		return r, invalid
	}
	if command == "agent" && !newline {
		return r, invalid
	}
	if command != "agent" {
		if _, err := in.ReadByte(); !errors.Is(err, io.EOF) {
			return r, invalid
		}
	}
	if !utf8.Valid(line) {
		return r, invalid
	}
	fields, err := uniqueObject(line)
	if err != nil {
		return r, invalid
	}
	defer func() {
		for _, value := range fields {
			clear(value)
		}
	}()
	var version int
	if err := json.Unmarshal(fields["protocol"], &version); err != nil || version != protocolVersion {
		return r, invalid
	}
	allowed := map[string]bool{"protocol": true}
	switch command {
	case "generate-key":
	case "import-key":
		allowed["privateKey"], allowed["passphrase"] = true, true
	case "agent":
		allowed["privateKey"], allowed["endpoint"] = true, true
	case "secure-path":
		allowed["path"], allowed["directory"], allowed["verifyOnly"] = true, true, true
	default:
		return r, unsupported
	}
	for name := range fields {
		if !allowed[name] {
			return r, invalid
		}
	}
	if command == "import-key" || command == "agent" {
		r.PrivateKey, err = decodeSecret(fields["privateKey"], maxKeyBytes)
		if err != nil || len(r.PrivateKey) == 0 {
			r.wipe()
			return request{}, invalid
		}
	}
	if value, present := fields["passphrase"]; present {
		r.HasPassphrase = true
		r.Passphrase, err = decodeSecret(value, maxPassphraseBytes)
		if err != nil {
			r.wipe()
			return request{}, invalid
		}
	}
	if command == "agent" {
		if err = json.Unmarshal(fields["endpoint"], &r.Endpoint); err != nil || r.Endpoint == "" || len(r.Endpoint) > 4096 {
			r.wipe()
			return request{}, invalid
		}
	}
	if command == "secure-path" {
		if err = json.Unmarshal(fields["path"], &r.Path); err != nil || r.Path == "" || len(r.Path) > 32768 {
			return r, invalid
		}
		value, present := fields["directory"]
		if !present || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &r.Directory) != nil {
			return r, invalid
		}
		if value, present = fields["verifyOnly"]; present {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &r.VerifyOnly) != nil {
				return r, invalid
			}
		}
	}
	return r, ""
}

func uniqueObject(data []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, invalid
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return nil, invalid
		}
		name, ok := token.(string)
		if !ok {
			return nil, invalid
		}
		if _, exists := fields[name]; exists {
			return nil, invalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, invalid
		}
		fields[name] = value
	}
	if _, err = d.Token(); err != nil {
		return nil, invalid
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return nil, invalid
	}
	return fields, nil
}

func decodeSecret(value json.RawMessage, limit int) ([]byte, error) {
	var encoded string
	if len(value) == 0 || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &encoded) != nil {
		return nil, invalid
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(limit) {
		return nil, invalid
	}
	// Strict plus round-trip rejects whitespace and noncanonical encodings.
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(decoded) > limit || base64.StdEncoding.EncodeToString(decoded) != encoded {
		clear(decoded)
		return nil, invalid
	}
	return decoded, nil
}
