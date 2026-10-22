from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = Path(os.environ.get("DB_PATH", REPO_ROOT / "data" / "orchestrator.db"))

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    with _lock:
        conn = _connection()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_name TEXT NOT NULL,
                title TEXT NOT NULL,
                session_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL REFERENCES chats(id),
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        # Added after the fact, so existing databases get them here rather than in
        # the CREATE above, which only ever runs for a fresh file. NULL means "as
        # the CLI is configured" — the app has no opinion until one is picked.
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(chats)")}
        for column in ("model", "effort"):
            if column not in existing:
                conn.execute(f"ALTER TABLE chats ADD COLUMN {column} TEXT")
        conn.commit()


def create_chat(group_name: str, title: str) -> int:
    with _lock:
        conn = _connection()
        cur = conn.execute(
            "INSERT INTO chats (group_name, title, session_id, created_at) VALUES (?, ?, NULL, ?)",
            (group_name, title, _now()),
        )
        conn.commit()
        return cur.lastrowid


def list_chats(group_name: str) -> list[dict]:
    with _lock:
        conn = _connection()
        rows = conn.execute(
            "SELECT id, group_name, title, session_id, model, effort, created_at FROM chats "
            "WHERE group_name = ? ORDER BY id DESC",
            (group_name,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_chat(chat_id: int) -> dict | None:
    with _lock:
        conn = _connection()
        row = conn.execute(
            "SELECT id, group_name, title, session_id, model, effort, created_at FROM chats WHERE id = ?",
            (chat_id,),
        ).fetchone()
        return dict(row) if row else None


def update_chat_session(chat_id: int, session_id: str) -> None:
    with _lock:
        conn = _connection()
        conn.execute("UPDATE chats SET session_id = ? WHERE id = ?", (session_id, chat_id))
        conn.commit()


def update_chat_model(chat_id: int, model: str | None, effort: str | None) -> None:
    """Both are stored as given, NULL included — NULL means the CLI's own default."""
    with _lock:
        conn = _connection()
        conn.execute(
            "UPDATE chats SET model = ?, effort = ? WHERE id = ?", (model, effort, chat_id)
        )
        conn.commit()


def update_chat_title(chat_id: int, title: str) -> None:
    with _lock:
        conn = _connection()
        conn.execute("UPDATE chats SET title = ? WHERE id = ?", (title, chat_id))
        conn.commit()


def delete_chat(chat_id: int) -> None:
    with _lock:
        conn = _connection()
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
        conn.commit()


def add_message(chat_id: int, role: str, content: str) -> int:
    with _lock:
        conn = _connection()
        cur = conn.execute(
            "INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (chat_id, role, content, _now()),
        )
        conn.commit()
        return cur.lastrowid


def list_messages(chat_id: int) -> list[dict]:
    with _lock:
        conn = _connection()
        rows = conn.execute(
            "SELECT id, chat_id, role, content, created_at FROM messages "
            "WHERE chat_id = ? ORDER BY id ASC",
            (chat_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_messages_between(group_names: list[str], start: str, end: str) -> list[dict]:
    """User and assistant messages of these groups' chats with start <= created_at < end.

    Bounds are UTC ISO strings in the same format _now() writes, so comparing them
    as text orders them correctly.
    """
    if not group_names:
        return []
    marks = ",".join("?" for _ in group_names)
    with _lock:
        conn = _connection()
        rows = conn.execute(
            "SELECT m.role, m.content, m.created_at, c.id AS chat_id, c.title AS chat_title, "
            "c.group_name FROM messages m JOIN chats c ON c.id = m.chat_id "
            f"WHERE c.group_name IN ({marks}) AND m.role IN ('user', 'assistant') "
            "AND m.created_at >= ? AND m.created_at < ? "
            "ORDER BY c.group_name, m.chat_id, m.id",
            (*group_names, start, end),
        ).fetchall()
        return [dict(r) for r in rows]
