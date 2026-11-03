//go:build !windows

package backendgo

func allowEditorForeground() {}

func editorWindowSnapshot(program string) map[uintptr]bool { return nil }

func awaitEditorWindow(program, dir string, before map[uintptr]bool) error { return nil }
