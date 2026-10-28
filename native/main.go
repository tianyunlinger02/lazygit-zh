package main

import (
	"bufio"
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
)

// Process identity is internal to ownership checks, never a protocol response.
type identity struct {
	ID   string
	Name string
}

func main() {
	// agent.ServeAgent may log parser errors. Never expose its diagnostics or
	// input material on stderr; the protocol is the sole application output.
	log.SetOutput(io.Discard)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { <-ctx.Done(); _ = os.Stdin.Close() }()
	// Panic/crash handling is deliberately not an error-detail transport.
	exit := 1
	func() {
		defer func() {
			if recover() != nil {
				exit = 1
			}
		}()
		exit = run(ctx, os.Stdin, os.Stdout, os.Args[1:])
	}()
	os.Exit(exit)
}

func run(ctx context.Context, in io.Reader, out io.Writer, args []string) int {
	finish := func(value response) int {
		defer clear(value.PrivateKey)
		if writeResponse(out, value) != nil {
			return 1
		}
		return 0
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		return finish(failed(unsupported))
	}
	if len(args) != 1 {
		return finish(failed(unsupported))
	}
	command := args[0]
	switch command {
	case "generate-key", "import-key", "agent", "secure-path":
	default:
		return finish(failed(unsupported))
	}
	reader := bufio.NewReaderSize(in, 8192)
	req, code := readRequest(reader, command)
	if ctx.Err() != nil {
		req.wipe()
		return 1
	}
	if code != "" {
		return finish(failed(code))
	}
	defer req.wipe()
	if command == "generate-key" || command == "import-key" {
		if _, code := currentIdentity(); code != "" {
			return finish(failed(code))
		}
	}
	switch command {
	case "generate-key":
		value, code := generateKey()
		if code != "" {
			return finish(failed(code))
		}
		return finish(value)
	case "import-key":
		value, code := importKey(req.PrivateKey, req.Passphrase, req.HasPassphrase)
		if code != "" {
			return finish(failed(code))
		}
		return finish(value)
	case "secure-path":
		if code := securePath(req.Path, req.Directory, req.VerifyOnly); code != "" {
			return finish(failed(code))
		}
		return finish(success())
	case "agent":
		return runAgent(ctx, reader, out, &req)
	}
	return finish(failed(unsupported))
}
