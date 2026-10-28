//go:build windows

package main

import (
	"net"
	"path/filepath"
	"strings"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func currentSID() (*windows.SID, string, string, failure) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return nil, "", "", unavailable
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user.User.Sid == nil {
		return nil, "", "", account
	}
	// Copy out of the token result so the returned SID owns its backing storage.
	sid, err := windows.StringToSid(user.User.Sid.String())
	if err != nil {
		return nil, "", "", account
	}
	name, domain, kind, err := sid.LookupAccount("")
	if err != nil || name == "" || kind != 1 {
		return nil, "", "", account
	}
	return sid, name, domain, ""
}
func currentIdentity() (identity, failure) {
	sid, name, domain, code := currentSID()
	if code != "" {
		return identity{}, code
	}
	if domain != "" {
		name = domain + `\` + name
	}
	return identity{ID: "sid:" + sid.String(), Name: name}, ""
}

const fileAllAccess = 0x001f01ff

// Hold every component without FILE_SHARE_DELETE. OPEN_REPARSE_POINT rejects
// links/junctions instead of silently operating on their destinations.
func openWindowsPath(path string, changeACL bool) ([]windows.Handle, failure) {
	volume := filepath.VolumeName(path)
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(volume) != 2 || volume[1] != ':' || strings.ContainsAny(path, "\x00/") {
		return nil, invalid
	}
	if path == volume+`\` {
		return nil, denied
	}
	parts := strings.Split(strings.TrimPrefix(path[len(volume):], `\`), `\`)
	handles := make([]windows.Handle, 0, len(parts)+1)
	closeFailure := func(code failure) ([]windows.Handle, failure) { closeWindowsPath(handles); return nil, code }
	current := volume + `\`
	for index := -1; index < len(parts); index++ {
		if index >= 0 {
			if parts[index] == "" || strings.Contains(parts[index], ":") || strings.HasSuffix(parts[index], ".") || strings.HasSuffix(parts[index], " ") {
				return closeFailure(invalid)
			}
			current = filepath.Join(current, parts[index])
		}
		wide, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return closeFailure(invalid)
		}
		access := uint32(windows.READ_CONTROL | windows.FILE_READ_ATTRIBUTES)
		if index == len(parts)-1 && changeACL {
			access |= windows.WRITE_DAC
		}
		handle, err := windows.CreateFile(wide, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			return closeFailure(denied)
		}
		handles = append(handles, handle)
		var info windows.ByHandleFileInformation
		if windows.GetFileInformationByHandle(handle, &info) != nil {
			return closeFailure(unavailable)
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return closeFailure(denied)
		}
		if index != len(parts)-1 && info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return closeFailure(denied)
		}
	}
	return handles, ""
}
func closeWindowsPath(handles []windows.Handle) {
	for index := len(handles) - 1; index >= 0; index-- {
		_ = windows.CloseHandle(handles[index])
	}
}

func checkWindowsOwner(handle windows.Handle, sid *windows.SID) failure {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return unavailable
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil || !windows.EqualSid(owner, sid) {
		return denied
	}
	return ""
}

// Ancestors may be readable by other users, but not writable by untrusted
// principals. Administrators/SYSTEM are trusted OS principals here only;
// neither Administrators nor any other extra principal is granted target ACLs.
func checkWindowsParent(handle windows.Handle, sid *windows.SID) failure {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return unavailable
	}
	owner, _, err := descriptor.Owner()
	if err != nil || owner == nil {
		return denied
	}
	if !windows.EqualSid(owner, sid) && !owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return denied
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil {
		return denied
	}
	const mutationMask = 0x000d0156 | windows.GENERIC_ALL | windows.GENERIC_WRITE
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return unavailable
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		if ace.Header.AceType != 0 {
			return denied
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if windows.EqualSid(principal, sid) || principal.IsWellKnown(windows.WinLocalSystemSid) || principal.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			continue
		}
		if uint32(ace.Mask)&mutationMask != 0 {
			return denied
		}
	}
	return ""
}

// Read-only validation also accepts an equivalent effective inherited DACL.
// Post-hardening validation requires the exact protected, explicit form.
func verifyPrivateDACL(handle windows.Handle, sid *windows.SID, directory, allowInherited bool) failure {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return unavailable
	}
	control, _, err := descriptor.Control()
	protected := err == nil && control&windows.SE_DACL_PROTECTED != 0
	if err != nil || (!allowInherited && !protected) {
		return denied
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil || acl.AceCount < 1 || acl.AceCount > 2 {
		return denied
	}
	seenUser, seenSystem := false, false
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return unavailable
		}
		flags := uint8(0)
		if directory {
			flags = windows.OBJECT_INHERIT_ACE | windows.CONTAINER_INHERIT_ACE
		}
		if protected && ace.Header.AceFlags&windows.INHERITED_ACE != 0 {
			return denied
		}
		if allowInherited && !protected && ace.Header.AceFlags&windows.INHERITED_ACE == 0 {
			return denied
		}
		actualFlags := ace.Header.AceFlags &^ windows.INHERITED_ACE
		if ace.Header.AceType != 0 || actualFlags != flags || uint32(ace.Mask) != fileAllAccess {
			return denied
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		isUser := windows.EqualSid(principal, sid)
		isSystem := principal.IsWellKnown(windows.WinLocalSystemSid)
		if !isUser && !isSystem {
			return denied
		}
		seenUser = seenUser || isUser
		seenSystem = seenSystem || isSystem
	}
	if !seenUser || !seenSystem {
		return denied
	}
	return checkWindowsOwner(handle, sid)
}

// verifyOnly never requests WRITE_DAC or changes ACLs on an existing path.
// The default mode hardens newly created, current-user-owned paths.
func securePath(path string, directory, verifyOnly bool) failure {
	sid, _, _, code := currentSID()
	if code != "" {
		return code
	}
	handles, code := openWindowsPath(path, !verifyOnly)
	if code != "" {
		return code
	}
	defer closeWindowsPath(handles)
	// The drive root is pinned and checked for reparse points above. Every
	// non-root containing directory must pass its ACL check; errors fail closed.
	for _, parent := range handles[1 : len(handles)-1] {
		if code := checkWindowsParent(parent, sid); code != "" {
			return code
		}
	}
	handle := handles[len(handles)-1]
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil {
		return unavailable
	}
	if (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return denied
	}
	if code := checkWindowsOwner(handle, sid); code != "" {
		return code
	}
	if verifyOnly {
		return verifyPrivateDACL(handle, sid, directory, true)
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;" + flags + ";FA;;;" + sid.String() + ")(A;" + flags + ";FA;;;SY)")
	if err != nil {
		return unavailable
	}
	acl, _, err := descriptor.DACL()
	if err != nil || acl == nil {
		return unavailable
	}
	if windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil) != nil {
		return denied
	}
	return verifyPrivateDACL(handle, sid, directory, false)
}

func listenAgent(endpoint string) (net.Listener, failure) {
	const prefix = `\\.\pipe\autogit-`
	if !strings.HasPrefix(endpoint, prefix) {
		return nil, invalid
	}
	name := strings.TrimPrefix(endpoint, prefix)
	if len(name) < 16 || len(name) > 100 {
		return nil, invalid
	}
	for _, char := range name {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-') {
			return nil, invalid
		}
	}
	sid, _, _, code := currentSID()
	if code != "" {
		return nil, code
	}
	// go-winio sets FILE_PIPE_REJECT_REMOTE_CLIENTS and atomically requires a
	// new endpoint. Only this token SID is granted access (not ambient agents).
	listener, err := winio.ListenPipe(endpoint, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + sid.String() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		return nil, unavailable
	}
	return listener, ""
}
