package servers

import (
	"regexp"
	"sort"
)

// Server ids become directory and container names, so they are restricted
// to a safe alphabet before any filesystem or Docker call.
var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$`)

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
