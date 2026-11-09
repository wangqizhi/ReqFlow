package backendgo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
)

const aiChatSchema = `PRAGMA busy_timeout=15000;
CREATE TABLE IF NOT EXISTS chat_state (project TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project, kind));
CREATE TABLE IF NOT EXISTS chat_turns (seq INTEGER PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL, messages TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chat_turns_project_session ON chat_turns(project, session, seq);`

func (b *Backend) openAIChat() (*sql.DB, error) {
	db, err := sql.Open("sqlite", filepath.Join(b.DataDir, "ai-chat.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(aiChatSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func saveChatState(tx *sql.Tx, project, kind string, value any) error {
	if value == nil {
		_, err := tx.Exec(`DELETE FROM chat_state WHERE project = ? AND kind = ?`, project, kind)
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO chat_state(project, kind, value) VALUES(?, ?, ?)
ON CONFLICT(project, kind) DO UPDATE SET value = excluded.value`, project, kind, string(raw))
	return err
}

func saveChatTurn(tx *sql.Tx, project string, turn map[string]any) error {
	session, stamp := aiString(turn["session"]), aiString(turn["time"])
	messages := aiArray(turn["messages"])
	if session == "" || stamp == "" || len(messages) != 2 {
		return errors.New("聊天室历史记录参数无效")
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO chat_turns(project, session, time, title, messages) VALUES(?, ?, ?, ?, ?)`,
		project, session, stamp, aiLimit(aiString(turn["title"]), 100), string(raw))
	return err
}

func (b *Backend) aiChatStore(channel string, args []any) (any, error) {
	project := aiString(aiArg(args, 0))
	clearAll := channel == "ai:chat:clear-history" && len(args) == 1 && args[0] == nil
	if project == "" && !clearAll {
		return nil, errors.New("缺少项目 ID")
	}
	db, err := b.openAIChat()
	if err != nil {
		return nil, fmt.Errorf("无法打开本地聊天室数据：%w", err)
	}
	defer db.Close()
	switch channel {
	case "ai:chat:state":
		rows, err := db.Query(`SELECT kind, value FROM chat_state WHERE project = ?`, project)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		state := map[string]any{}
		for rows.Next() {
			var kind, value string
			if err := rows.Scan(&kind, &value); err != nil {
				return nil, err
			}
			var decoded map[string]any
			if json.Unmarshal([]byte(value), &decoded) != nil || decoded == nil {
				return nil, errors.New("本地聊天室草稿或设置格式损坏")
			}
			state[kind] = decoded
		}
		return desktopOK(state), rows.Err()
	case "ai:chat:save-draft", "ai:chat:save-sources":
		tx, err := db.Begin()
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		kind := "draft"
		if channel == "ai:chat:save-sources" {
			kind = "sources"
		}
		if err := saveChatState(tx, project, kind, aiArg(args, 1)); err != nil {
			return nil, err
		}
		if turn := aiMap(aiArg(args, 2)); kind == "draft" && turn != nil {
			if err := saveChatTurn(tx, project, turn); err != nil {
				return nil, err
			}
		}
		return desktopOK(nil), tx.Commit()
	case "ai:chat:history":
		rows, err := db.Query(`SELECT first.session, first.title, last.time FROM chat_turns AS first
JOIN (SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq FROM chat_turns WHERE project = ? GROUP BY session) AS sessions ON first.seq = sessions.first_seq
JOIN chat_turns AS last ON last.seq = sessions.last_seq ORDER BY last.seq DESC`, project)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		entries := []map[string]string{}
		for rows.Next() {
			var id, title, stamp string
			if err := rows.Scan(&id, &title, &stamp); err != nil {
				return nil, err
			}
			entries = append(entries, map[string]string{"id": id, "title": title, "time": stamp})
		}
		return desktopOK(map[string]any{"entries": entries}), rows.Err()
	case "ai:chat:read-history":
		rows, err := db.Query(`SELECT messages FROM chat_turns WHERE project = ? AND session = ? ORDER BY seq`, project, aiString(aiArg(args, 1)))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		messages := []json.RawMessage{}
		for rows.Next() {
			var raw string
			if err := rows.Scan(&raw); err != nil {
				return nil, err
			}
			var turn []json.RawMessage
			if json.Unmarshal([]byte(raw), &turn) != nil {
				return nil, errors.New("本地聊天历史记录格式损坏")
			}
			messages = append(messages, turn...)
		}
		return desktopOK(map[string]any{"messages": messages}), rows.Err()
	case "ai:chat:clear-history":
		if clearAll {
			_, err = db.Exec(`DELETE FROM chat_turns`)
		} else {
			_, err = db.Exec(`DELETE FROM chat_turns WHERE project = ?`, project)
		}
		return desktopOK(nil), err
	}
	return nil, errors.New("不支持的聊天室数据操作")
}
