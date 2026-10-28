//go:build darwin

package sysinfo

import "golang.org/x/sys/unix"

func memoryTotal() uint64 {
	v, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return v
}
