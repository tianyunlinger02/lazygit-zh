package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

var nativeTestRoot string

func TestMain(tests *testing.M) {
	// Never let testing.T.TempDir or subprocess caches default to system /tmp.
	root, err := filepath.Abs("..")
	if err != nil {
		os.Exit(1)
	}
	parent := filepath.Join(root, ".claude-tmp")
	if err := os.MkdirAll(parent, 0700); err != nil {
		os.Exit(1)
	}
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		os.Exit(1)
	}
	nativeTestRoot, err = os.MkdirTemp(parent, "nt-")
	if err != nil {
		os.Exit(1)
	}
	if os.Chmod(nativeTestRoot, 0700) != nil {
		os.Exit(1)
	}
	for _, name := range []string{"TMPDIR", "TMP", "TEMP", "GOTMPDIR"} {
		if os.Setenv(name, nativeTestRoot) != nil {
			os.Exit(1)
		}
	}
	code := tests.Run()
	if os.RemoveAll(nativeTestRoot) != nil {
		fmt.Fprintln(os.Stderr, "Could not clean native test directory.")
		code = 1
	}
	os.Exit(code)
}

func shortTestDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp(nativeTestRoot, "a-")
	if err != nil {
		t.Fatal("Could not create test directory")
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal("Could not secure test directory")
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}
