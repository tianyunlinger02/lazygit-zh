//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func windowsFixtureSecurity(t *testing.T, path string) (string, windows.SECURITY_DESCRIPTOR_CONTROL) {
	t.Helper()
	handles, code := openWindowsPath(path, false)
	if code != "" {
		t.Fatal("Could not open fixture security read-only")
	}
	defer closeWindowsPath(handles)
	descriptor, err := windows.GetSecurityInfo(handles[len(handles)-1], windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal("Could not inspect fixture security")
	}
	control, _, err := descriptor.Control()
	if err != nil || descriptor.String() == "" {
		t.Fatal("Could not snapshot fixture security")
	}
	return descriptor.String(), control
}

func setWindowsFixtureDACL(t *testing.T, path, sddl string) {
	t.Helper()
	handles, code := openWindowsPath(path, true)
	if code != "" {
		t.Fatal("Could not open owned test fixture for ACL setup")
	}
	defer closeWindowsPath(handles)
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal("Could not encode fixture DACL")
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil {
		t.Fatal("Could not inspect fixture DACL")
	}
	if windows.SetSecurityInfo(handles[len(handles)-1], windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil) != nil {
		t.Fatal("Could not set owned fixture DACL")
	}
}

func TestWindowsSecurePathVerifyOnlyAcceptsPrivateInheritedPathsWithoutMutation(t *testing.T) {
	root := shortTestDirectory(t)
	if code := securePath(root, true, false); code != "" {
		t.Fatalf("Could not harden owned fixture root: %s", code)
	}
	before, control := windowsFixtureSecurity(t, root)
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("Default hardening did not protect the fixture DACL")
	}
	if code := securePath(root, true, true); code != "" {
		t.Fatal("Read-only check refused a hardened root")
	}
	if after, _ := windowsFixtureSecurity(t, root); after != before {
		t.Fatal("Read-only root verification mutated its security descriptor")
	}
	child := filepath.Join(root, "records")
	if os.Mkdir(child, 0700) != nil {
		t.Fatal("Could not create inherited fixture directory")
	}
	file := filepath.Join(child, "profile.json")
	if os.WriteFile(file, []byte("offline fixture metadata"), 0600) != nil {
		t.Fatal("Could not create inherited fixture file")
	}
	// Vault writes install a same-directory temporary file by atomic rename.
	temporary, installed := filepath.Join(root, "vault.tmp"), filepath.Join(root, "vault.json")
	if os.WriteFile(temporary, []byte("offline fixture ciphertext"), 0600) != nil || os.Rename(temporary, installed) != nil {
		t.Fatal("Could not install inherited atomic-write fixture")
	}
	for _, item := range []struct {
		path      string
		directory bool
	}{{child, true}, {file, false}, {installed, false}} {
		before, control := windowsFixtureSecurity(t, item.path)
		if control&windows.SE_DACL_PROTECTED != 0 {
			t.Fatal("Fixture did not exercise an inherited DACL")
		}
		if code := securePath(item.path, item.directory, true); code != "" {
			t.Fatalf("Safe inherited fixture was refused: %s", code)
		}
		if after, _ := windowsFixtureSecurity(t, item.path); after != before {
			t.Fatal("Read-only inherited-path verification mutated its security descriptor")
		}
	}
}

func TestWindowsSecurePathVerifyOnlyRejectsUnsafeACLWithoutMutation(t *testing.T) {
	for _, directory := range []bool{false, true} {
		name := "file"
		if directory {
			name = "directory"
		}
		t.Run(name, func(t *testing.T) {
			root := shortTestDirectory(t)
			if code := securePath(root, true, false); code != "" {
				t.Fatal("Could not harden fixture parent")
			}
			target := filepath.Join(root, "unsafe-fixture")
			if directory {
				if os.Mkdir(target, 0700) != nil {
					t.Fatal("Could not create fixture directory")
				}
			} else if os.WriteFile(target, nil, 0600) != nil {
				t.Fatal("Could not create fixture file")
			}
			sid, _, _, code := currentSID()
			if code != "" {
				t.Fatal("Could not identify fixture owner")
			}
			flags := ""
			if directory {
				flags = "OICI"
			}
			// Only this disposable fixture is changed, never a user's existing ACL.
			setWindowsFixtureDACL(t, target, "D:P(A;"+flags+";FA;;;"+sid.String()+")(A;"+flags+";FA;;;SY)(A;"+flags+";FR;;;WD)")
			before, _ := windowsFixtureSecurity(t, target)
			if code := securePath(target, directory, true); code != denied {
				t.Fatal("Read-only verification accepted a public-read fixture")
			}
			if after, _ := windowsFixtureSecurity(t, target); after != before {
				t.Fatal("Rejected read-only verification changed the fixture ACL")
			}
			if code := securePath(target, directory, false); code != "" {
				t.Fatal("Explicit default hardening failed")
			}
			after, control := windowsFixtureSecurity(t, target)
			if after == before || control&windows.SE_DACL_PROTECTED == 0 {
				t.Fatal("Default hardening did not install a protected private ACL")
			}
			if code := securePath(target, directory, true); code != "" {
				t.Fatal("Read-only verification refused the hardened fixture")
			}
		})
	}
}

func TestWindowsSecurePathVerifyOnlyRejectsMissingPathsTypesAndHardlinks(t *testing.T) {
	root := shortTestDirectory(t)
	if code := securePath(root, true, false); code != "" {
		t.Fatal("Could not harden fixture parent")
	}
	missing := filepath.Join(root, "missing")
	if code := securePath(missing, false, true); code == "" {
		t.Fatal("Missing path passed verification")
	}
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatal("Read-only check created a missing path")
	}
	file := filepath.Join(root, "file")
	if os.WriteFile(file, nil, 0600) != nil {
		t.Fatal("Could not create fixture file")
	}
	before, _ := windowsFixtureSecurity(t, file)
	if securePath(file, true, true) == "" || securePath(root, false, true) == "" {
		t.Fatal("Mismatched path type passed verification")
	}
	if os.Link(file, filepath.Join(root, "hardlink")) != nil {
		t.Fatal("Could not create fixture hard link")
	}
	if code := securePath(file, false, true); code == "" {
		t.Fatal("Multiply linked file passed verification")
	}
	if after, _ := windowsFixtureSecurity(t, file); after != before {
		t.Fatal("Rejected type/link verification changed the fixture ACL")
	}
	for _, path := range []string{`\\server\share\offline`, file + ":stream", filepath.ToSlash(file)} {
		if code := securePath(path, false, true); code == "" {
			t.Fatal("Unsupported Windows path passed verification")
		}
	}
}
