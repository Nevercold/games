package servers

import "sync"

const consoleHistoryBytes = 128 << 10

// Console keeps recent output and fans it out to live subscribers.
type Console struct {
	mu      sync.Mutex
	history []byte
	subs    map[int]chan []byte
	nextID  int
}

func newConsole() *Console {
	return &Console{subs: map[int]chan []byte{}}
}

// Write appends output. Slow subscribers miss chunks instead of blocking the
// container's output pump.
func (c *Console) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	chunk := append([]byte(nil), p...)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.history = append(c.history, chunk...)
	if over := len(c.history) - consoleHistoryBytes; over > 0 {
		c.history = append([]byte(nil), c.history[over:]...)
	}
	for _, ch := range c.subs {
		select {
		case ch <- chunk:
		default:
		}
	}
	return len(p), nil
}

// System writes a highlighted daemon message.
func (c *Console) System(msg string) {
	_, _ = c.Write([]byte("\x1b[1;33m[Daemon]\x1b[0m " + msg + "\r\n"))
}

// Subscribe returns a history snapshot and a channel of new output.
func (c *Console) Subscribe() (history []byte, ch <-chan []byte, cancel func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextID
	c.nextID++
	out := make(chan []byte, 256)
	c.subs[id] = out
	return append([]byte(nil), c.history...), out, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if _, ok := c.subs[id]; ok {
			delete(c.subs, id)
			close(out)
		}
	}
}
