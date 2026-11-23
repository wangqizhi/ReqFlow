package backendgo

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func collectAntigravityStats(home string, start time.Time, add collectLocalUsage) {
	roots := []string{filepath.Join(home, ".config", "antigravity")}
	for _, name := range []string{"antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup", "antigravity-acp"} {
		roots = append(roots, filepath.Join(home, ".gemini", name))
	}
	if override := os.Getenv("ANTIGRAVITY_DATA_DIR"); override != "" {
		roots = append([]string{override}, roots...)
	}
	sessions, seen := map[string]bool{}, map[string]bool{}
	for _, root := range roots {
		// A live SQLite database can have recent records in its WAL while the
		// main file's modification time is older than the selected range.
		for _, file := range usageFiles(filepath.Join(root, "conversations"), time.Time{}, func(name string) bool {
			return strings.HasSuffix(name, ".db")
		}) {
			session := strings.TrimSuffix(filepath.Base(file), ".db")
			if !sessions[session] {
				sessions[session] = readAntigravityStatsDB(file, session, seen, add)
			}
		}
	}
	for _, root := range roots {
		brain := filepath.Join(root, "brain")
		entries, _ := os.ReadDir(brain)
		for _, entry := range entries {
			id := entry.Name()
			if !entry.IsDir() || !antigravityUUID.MatchString(id) || sessions[id] {
				continue
			}
			logs := filepath.Join(brain, id, ".system_generated", "logs")
			file := filepath.Join(logs, "transcript_full.jsonl")
			info, err := os.Stat(file)
			if os.IsNotExist(err) {
				file = filepath.Join(logs, "transcript.jsonl")
				info, err = os.Stat(file)
			}
			if err != nil || !info.Mode().IsRegular() || info.ModTime().Before(start) {
				continue
			}
			transcript := readAntigravityTranscript(file, id, nil)
			sessions[id] = len(transcript.steps) > 0
			for _, step := range transcript.steps {
				add("antigravity", id, "", localUsageStep{at: step.time, model: step.model, input: step.input + step.cached, output: step.output, cached: step.cached})
			}
		}
	}
}

// Compatible Antigravity databases carry usage in protobuf fields, separate
// from prompts or responses. The field layout follows ccusage's adapter:
// https://github.com/ccusage/ccusage/tree/main/rust/adapters/antigravity/src/parser
func readAntigravityStatsDB(file, session string, seen map[string]bool, add collectLocalUsage) bool {
	db, err := openUsageDB(file)
	if err != nil {
		return false
	}
	defer db.Close()
	found := false
	model := ""
	// The two tables can describe the same generation. Prefer gen_metadata
	// and use steps only for older databases without usable generator rows.
	for _, generator := range []bool{true, false} {
		query := "SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx"
		if generator {
			query = "SELECT data FROM gen_metadata ORDER BY idx"
		}
		rows, err := db.Query(query)
		if err != nil {
			continue
		}
		for rows.Next() {
			var data []byte
			if rows.Scan(&data) != nil {
				continue
			}
			fields := antigravityFields(data)
			usage, retries := fields[9], fields[28]
			stamp := firstProto(fields[8])
			modelInfo := antigravityFields(firstProto(fields[24]).data)
			name, modelID := protoText(modelInfo, 12, 8), firstProto(modelInfo[1]).number
			if len(stamp.data) == 0 {
				stamp = firstProto(fields[1])
			}
			if generator {
				chat := antigravityFields(firstProto(fields[1]).data)
				usage, retries = chat[4], chat[17]
				stamp = firstProto(antigravityFields(firstProto(chat[9]).data)[4])
				name, modelID = protoText(chat, 19, 21), firstProto(chat[3]).number
			}
			if name != "" {
				model = name
			} else if modelID > 0 {
				model = "antigravity-model-" + strconv.FormatUint(modelID, 10)
			}
			at := antigravityProtoTime(stamp.data)
			if at.IsZero() {
				continue
			}
			primary := firstProto(usage).data
			candidates := [][]byte{primary}
			for _, retry := range retries {
				candidates = append(candidates, firstProto(antigravityFields(retry.data)[2]).data)
			}
			mirrored := false
			var primaryStep localUsageStep
			for i, data := range candidates {
				u := antigravityFields(data)
				if len(u) == 0 {
					continue
				}
				number := func(field uint64) int64 { return int64(firstProto(u[field]).number) }
				name := model
				if id := number(1); id > 0 && (name == "" || modelID > 0 && uint64(id) != modelID) {
					name = "antigravity-model-" + strconv.FormatInt(id, 10)
				}
				reasoning := number(9)
				step := localUsageStep{at: at, model: name, input: number(2) + number(4) + number(5),
					output: max(number(3), number(10)+reasoning), cached: number(5), reasoning: reasoning}
				if step.model == "" || step.input+step.output <= 0 {
					continue
				}
				found = true
				if i == 0 {
					primaryStep = step
				} else if !mirrored && step == primaryStep {
					mirrored = true
					continue
				}
				identity := protoText(u, 11, 12, 7)
				if identity != "" {
					if seen[identity] {
						continue
					}
					seen[identity] = true
				}
				add("antigravity", session, "", step)
			}
		}
		rows.Close()
		if found {
			break
		}
	}
	return found
}

type antigravityProtoField struct {
	number uint64
	data   []byte
}

func firstProto(values []antigravityProtoField) antigravityProtoField {
	if len(values) == 0 {
		return antigravityProtoField{}
	}
	return values[0]
}

func protoText(fields map[uint64][]antigravityProtoField, ids ...uint64) string {
	for _, id := range ids {
		data := firstProto(fields[id]).data
		if len(data) > 0 && len(data) <= 300 && utf8.Valid(data) {
			return strings.TrimSpace(string(data))
		}
	}
	return ""
}

func antigravityProtoTime(data []byte) time.Time {
	fields := antigravityFields(data)
	seconds, nanos := firstProto(fields[1]).number, firstProto(fields[2]).number
	if seconds == 0 || seconds >= 253402300800 || nanos >= 1e9 {
		return time.Time{}
	}
	return time.Unix(int64(seconds), int64(nanos))
}

func antigravityFields(data []byte) map[uint64][]antigravityProtoField {
	fields := map[uint64][]antigravityProtoField{}
	for len(data) > 0 {
		tag, size := binary.Uvarint(data)
		if size <= 0 || tag>>3 == 0 {
			return nil
		}
		data = data[size:]
		field := antigravityProtoField{}
		switch tag & 7 {
		case 0:
			field.number, size = binary.Uvarint(data)
			if size <= 0 {
				return nil
			}
		case 1:
			size = 8
		case 2:
			length, n := binary.Uvarint(data)
			if n <= 0 || length > uint64(len(data)-n) {
				return nil
			}
			data, size = data[n:], int(length)
			field.data = data[:size]
		case 5:
			size = 4
		default:
			return nil
		}
		if size > len(data) {
			return nil
		}
		data = data[size:]
		fields[tag>>3] = append(fields[tag>>3], field)
	}
	return fields
}
