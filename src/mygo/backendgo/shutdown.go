package backendgo

// ActiveExecutionActions reads fresh shared storage so external CLI claims are
// included. Each release carries its run ID and cannot release a later owner.
func (s *WorkspaceService) ActiveExecutionActions() ([]map[string]any, error) {
	r, err := s.Get()
	if err != nil {
		return nil, err
	}
	actions := []map[string]any{}
	for _, pv := range coreList(coreMap(r["state"])["projects"]) {
		p := coreMap(pv)
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			if e := ActiveAIExecution(i); e != nil {
				actions = append(actions, map[string]any{"op": "executionRelease", "project": p["id"], "id": i["id"], "run": e["runId"], "note": "用户确认强制关闭 ReqFlow，任务返回排期表"})
			}
		}
	}
	return actions, nil
}

func (s *WorkspaceService) ReleaseForShutdown(actions []map[string]any) error {
	for _, a := range actions {
		if _, err := s.Mutate(a, nil); err != nil {
			return err
		}
	}
	return nil
}
