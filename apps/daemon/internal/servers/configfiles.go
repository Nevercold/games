package servers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

// applyConfigFiles patches config files inside the server root before start.
// Paths are resolved through os.Root, so they cannot escape the server dir.
func applyConfigFiles(root *os.Root, files []*panelv1.ConfigFile) []error {
	var errs []error
	for _, f := range files {
		if err := applyConfigFile(root, f); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", f.Path, err))
		}
	}
	return errs
}

func applyConfigFile(root *os.Root, f *panelv1.ConfigFile) error {
	name := strings.TrimPrefix(path.Clean("/"+f.Path), "/")
	if name == "" {
		return errors.New("empty path")
	}
	raw, err := root.ReadFile(name)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	var out []byte
	switch f.Parser {
	case "properties":
		out = patchProperties(raw, f.Set)
	case "text":
		out = patchText(raw, f.Set)
	case "json":
		out, err = patchStructured(raw, f.Set, json.Unmarshal, func(v any) ([]byte, error) {
			return json.MarshalIndent(v, "", "  ")
		})
	case "yaml":
		out, err = patchStructured(raw, f.Set, yaml.Unmarshal, yaml.Marshal)
	default:
		return fmt.Errorf("parser %q not supported yet", f.Parser)
	}
	if err != nil {
		return err
	}
	if dir := path.Dir(name); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return root.WriteFile(name, out, 0o644)
}

// patchProperties sets key=value lines, keeping comments and order.
func patchProperties(raw []byte, set map[string]string) []byte {
	lines := splitLines(raw)
	done := map[string]bool{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
			continue
		}
		key, _, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if v, want := set[key]; want {
			lines[i] = key + "=" + v
			done[key] = true
		}
	}
	for _, k := range sortedKeys(set) {
		if !done[k] {
			lines = append(lines, k+"="+set[k])
		}
	}
	return joinLines(lines)
}

// patchText replaces every line starting with a key by the given value
// (same semantics as the Wings "file" parser).
func patchText(raw []byte, set map[string]string) []byte {
	lines := splitLines(raw)
	for i, line := range lines {
		for _, k := range sortedKeys(set) {
			if strings.HasPrefix(line, k) {
				lines[i] = set[k]
				break
			}
		}
	}
	return joinLines(lines)
}

// patchStructured sets dot-separated paths in a JSON or YAML document.
// Values that look like numbers or booleans keep that type.
func patchStructured(
	raw []byte, set map[string]string,
	unmarshal func([]byte, any) error, marshal func(any) ([]byte, error),
) ([]byte, error) {
	doc := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("parse: %w", err)
		}
	}
	for _, k := range sortedKeys(set) {
		setPath(doc, strings.Split(k, "."), typedValue(set[k]))
	}
	return marshal(doc)
}

func setPath(m map[string]any, keys []string, v any) {
	for i, k := range keys {
		if i == len(keys)-1 {
			m[k] = v
			return
		}
		next, ok := m[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[k] = next
		}
		m = next
	}
}

func typedValue(s string) any {
	if b, err := strconv.ParseBool(s); err == nil {
		return b
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return i
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil && strings.Contains(s, ".") {
		return f
	}
	return s
}

func splitLines(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	s := strings.ReplaceAll(string(raw), "\r\n", "\n")
	return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}

func joinLines(lines []string) []byte {
	return []byte(strings.Join(lines, "\n") + "\n")
}
