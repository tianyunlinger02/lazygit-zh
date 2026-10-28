//go:build linux

package main

import (
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

func currentIdentity() (identity, failure) {
	ruid, euid, suid := unix.Getresuid()
	rgid, egid, sgid := unix.Getresgid()
	if ruid != euid || ruid != suid || rgid != egid || rgid != sgid {
		return identity{}, account
	}
	uid := strconv.Itoa(ruid)
	entry, err := user.LookupId(uid)
	if err != nil || entry.Uid != uid || entry.Username == "" || strings.ContainsAny(entry.Username, "\x00\r\n") {
		return identity{}, account
	}
	return identity{ID: "uid:" + uid, Name: entry.Username}, ""
}

// Even intermediate symbolic links are rejected. The final handle is O_PATH:
// permissions can be checked without reading file contents or opening a FIFO.
func openPathNoLinks(path string) (int, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.IndexByte(path, 0) >= 0 {
		return -1, invalid
	}
	fd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	if path == "/" {
		return fd, nil
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for index, part := range parts {
		flags := unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if index < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, err := unix.Openat(fd, part, flags, 0)
		_ = unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
		var info unix.Stat_t
		if err := unix.Fstat(fd, &info); err != nil {
			unix.Close(fd)
			return -1, err
		}
		if info.Mode&unix.S_IFMT == unix.S_IFLNK {
			unix.Close(fd)
			return -1, denied
		}
	}
	return fd, nil
}

func checkPrivateFD(fd int, directory bool) failure {
	var info unix.Stat_t
	if unix.Fstat(fd, &info) != nil {
		return unavailable
	}
	mode := uint32(unix.S_IFREG | 0600)
	if directory {
		mode = unix.S_IFDIR | 0700
	}
	if info.Uid != uint32(os.Getuid()) || info.Mode&(unix.S_IFMT|07777) != mode || (!directory && info.Nlink != 1) {
		return denied
	}
	return ""
}

// Linux path security is always read-only; both modes enforce the same checks.
func securePath(path string, directory, verifyOnly bool) failure {
	if _, code := currentIdentity(); code != "" {
		return code
	}
	fd, err := openPathNoLinks(path)
	if err != nil {
		return denied
	}
	defer unix.Close(fd)
	return checkPrivateFD(fd, directory)
}

type privateUnixListener struct {
	*net.UnixListener
	parent     int
	name       string
	once       sync.Once
	closeError error
}

func (l *privateUnixListener) Close() error {
	l.once.Do(func() {
		l.closeError = l.UnixListener.Close()
		_ = unix.Unlinkat(l.parent, l.name, 0)
		_ = unix.Close(l.parent)
	})
	return l.closeError
}
func (l *privateUnixListener) Accept() (net.Conn, error) {
	for {
		connection, err := l.UnixListener.AcceptUnix()
		if err != nil {
			return nil, err
		}
		raw, err := connection.SyscallConn()
		permitted := false
		if err == nil {
			err = raw.Control(func(fd uintptr) {
				peer, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
				permitted = e == nil && peer.Uid == uint32(os.Getuid())
			})
		}
		if err == nil && permitted {
			return connection, nil
		}
		_ = connection.Close()
	}
}
func listenAgent(endpoint string) (net.Listener, failure) {
	if _, code := currentIdentity(); code != "" {
		return nil, code
	}
	if !filepath.IsAbs(endpoint) || filepath.Clean(endpoint) != endpoint || strings.IndexByte(endpoint, 0) >= 0 || len(endpoint) > 107 {
		return nil, invalid
	}
	parent, err := openPathNoLinks(filepath.Dir(endpoint))
	if err != nil {
		return nil, denied
	}
	if code := checkPrivateFD(parent, true); code != "" {
		unix.Close(parent)
		return nil, code
	}
	name := filepath.Base(endpoint)
	// Binding via the pinned descriptor creates a socket inode in that exact
	// directory. Clients connect through endpoint, not the procfs spelling.
	bound := "/proc/self/fd/" + strconv.Itoa(parent) + "/" + name
	if len(bound) > 107 {
		unix.Close(parent)
		return nil, invalid
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: bound, Net: "unix"})
	if err != nil {
		unix.Close(parent)
		return nil, unavailable
	}
	listener.SetUnlinkOnClose(false)
	result := &privateUnixListener{UnixListener: listener, parent: parent, name: name}
	if unix.Fchmodat(parent, name, 0600, 0) != nil {
		result.Close()
		return nil, unavailable
	}
	// Refuse a parent-name replacement during startup rather than advertising
	// an endpoint different from the directory to which we actually bound.
	verified, err := openPathNoLinks(filepath.Dir(endpoint))
	if err != nil {
		result.Close()
		return nil, denied
	}
	var first, second unix.Stat_t
	valid := unix.Fstat(parent, &first) == nil && unix.Fstat(verified, &second) == nil && first.Dev == second.Dev && first.Ino == second.Ino
	_ = unix.Close(verified)
	if !valid {
		result.Close()
		return nil, denied
	}
	return result, ""
}
