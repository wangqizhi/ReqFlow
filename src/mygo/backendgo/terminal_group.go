package backendgo

// A detached window owns the project's terminal dock, including both tabs.
type terminalPeer struct {
	RunID string `json:"runId"`
	Agent string `json:"agent,omitempty"`
}

func (b *Backend) terminalPeers(id string) []terminalPeer {
	project := ""
	b.agentMu.Lock()
	if run := b.agentRuns[id]; run != nil {
		project = run.project
	}
	b.agentMu.Unlock()
	b.desktopPublishMu.Lock()
	if session, ok := b.desktopTerminalSessions[id]; ok {
		project = session.ProjectID
	}
	peers := []terminalPeer{}
	for key, session := range b.desktopTerminalSessions {
		if key == id || (project != "" && session.ProjectID == project) {
			peers = append(peers, terminalPeer{RunID: key})
		}
	}
	b.desktopPublishMu.Unlock()
	b.agentMu.Lock()
	for key, run := range b.agentRuns {
		if key == id || (project != "" && run.project == project) {
			peers = append(peers, terminalPeer{RunID: key, Agent: run.agent})
		}
	}
	b.agentMu.Unlock()
	return peers
}

func (b *Backend) terminalWindowID(id string) (string, bool, error) {
	for _, peer := range b.terminalPeers(id) {
		status, err := desktopNative(b, "terminal.status", peer.RunID)
		if err != nil {
			return id, false, err
		}
		if status == true {
			return peer.RunID, true, nil
		}
	}
	return id, false, nil
}

// Old runs remain available for replay/window ownership, but the dock shows
// only the latest publish session and current CLI, matching the main window.
func (b *Backend) currentTerminalPeers(id string) []terminalPeer {
	peers := b.terminalPeers(id)
	var publish, cli *terminalPeer
	var publishedAt, writtenAt int64
	cliDone := true
	for _, peer := range peers {
		if peer.Agent == "" {
			b.desktopPublishMu.Lock()
			started := b.desktopTerminalSessions[peer.RunID].StartedAt
			b.desktopPublishMu.Unlock()
			if publish == nil || started > publishedAt || (started == publishedAt && peer.RunID == id) {
				copy := peer
				publish = &copy
				publishedAt = started
			}
		} else {
			b.agentMu.Lock()
			run := b.agentRuns[peer.RunID]
			run.mu.Lock()
			done, written := run.done, run.lastWrite
			run.mu.Unlock()
			b.agentMu.Unlock()
			if cli == nil || (cliDone && !done) || (cliDone == done && (written > writtenAt || (written == writtenAt && peer.RunID == id))) {
				copy := peer
				cli = &copy
				cliDone = done
				writtenAt = written
			}
		}
	}
	current := []terminalPeer{}
	if cli != nil {
		current = append(current, *cli)
	}
	if publish != nil {
		current = append(current, *publish)
	}
	return current
}
