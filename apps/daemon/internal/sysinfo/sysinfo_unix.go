//go:build linux || darwin

package sysinfo

import (
	"bytes"

	"golang.org/x/sys/unix"
)

func kernelVersion() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return ""
	}
	return string(bytes.TrimRight(u.Release[:], "\x00"))
}
