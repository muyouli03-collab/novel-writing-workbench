"""原稿分析会话持久化:保存追加式消息历史,支持跨请求继续对话。"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

from . import config


DB_PATH = config.DATA_DIR / "draft_sessions.db"
_JSON_FIELDS = {"messages", "units", "clarification", "retrieval_config", "retrieval_results", "annotations", "events", "reference_ids", "knowledge_context"}
_UPDATABLE = {"draft", "supplement", "status", "project_id", "chapter_id", *_JSON_FIELDS}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        conn.row_factory = sqlite3.Row
        with conn:
            yield conn
    finally:
        conn.close()


def _init():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS draft_sessions (
                id TEXT PRIMARY KEY,
                draft TEXT NOT NULL,
                supplement TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                messages TEXT NOT NULL,
                units TEXT NOT NULL,
                clarification TEXT NOT NULL DEFAULT '{}',
                retrieval_config TEXT NOT NULL DEFAULT '{}',
                retrieval_results TEXT NOT NULL,
                annotations TEXT NOT NULL,
                events TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(draft_sessions)")}
        if "supplement" not in columns:
            conn.execute(
                "ALTER TABLE draft_sessions ADD COLUMN supplement TEXT NOT NULL DEFAULT ''"
            )
        if "clarification" not in columns:
            conn.execute(
                "ALTER TABLE draft_sessions ADD COLUMN clarification TEXT NOT NULL DEFAULT '{}'"
            )
        if "retrieval_config" not in columns:
            conn.execute(
                "ALTER TABLE draft_sessions ADD COLUMN retrieval_config TEXT NOT NULL DEFAULT '{}'"
            )
        if "project_id" not in columns:
            conn.execute("ALTER TABLE draft_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT ''")
        if "chapter_id" not in columns:
            conn.execute("ALTER TABLE draft_sessions ADD COLUMN chapter_id TEXT NOT NULL DEFAULT ''")
        if "reference_ids" not in columns:
            conn.execute("ALTER TABLE draft_sessions ADD COLUMN reference_ids TEXT NOT NULL DEFAULT '[]'")
        if "knowledge_context" not in columns:
            conn.execute("ALTER TABLE draft_sessions ADD COLUMN knowledge_context TEXT NOT NULL DEFAULT '{}'")


def _decode(row) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    for key in _JSON_FIELDS:
        try:
            data[key] = json.loads(data.get(key) or "[]")
        except (json.JSONDecodeError, TypeError):
            data[key] = {} if key in ("clarification", "retrieval_config", "retrieval_results", "knowledge_context") else []
    return data


def create(draft: str, messages: list, supplement: str = "", project_id: str = "",
           chapter_id: str = "", reference_ids: list | None = None,
           knowledge_context: dict | None = None) -> dict:
    session_id = "draft_" + uuid4().hex
    now = _now()
    values = {
        "id": session_id,
        "draft": draft,
        "supplement": supplement,
        "project_id": project_id,
        "chapter_id": chapter_id,
        "reference_ids": reference_ids or [],
        "knowledge_context": knowledge_context or {},
        "status": "analyzing",
        "messages": messages,
        "units": [],
        "clarification": {},
        "retrieval_config": {},
        "retrieval_results": {},
        "annotations": [],
        "events": [],
        "created_at": now,
        "updated_at": now,
    }
    with _connect() as conn:
        conn.execute(
            """INSERT INTO draft_sessions (
                id, draft, supplement, status, messages, units, clarification,
                retrieval_config, retrieval_results, annotations, events, created_at, updated_at,
                project_id, chapter_id, reference_ids, knowledge_context
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                values["id"], values["draft"], values["supplement"], values["status"],
                json.dumps(values["messages"], ensure_ascii=False),
                json.dumps(values["units"], ensure_ascii=False),
                json.dumps(values["clarification"], ensure_ascii=False),
                json.dumps(values["retrieval_config"], ensure_ascii=False),
                json.dumps(values["retrieval_results"], ensure_ascii=False),
                json.dumps(values["annotations"], ensure_ascii=False),
                json.dumps(values["events"], ensure_ascii=False),
                values["created_at"], values["updated_at"], values["project_id"], values["chapter_id"],
                json.dumps(values["reference_ids"], ensure_ascii=False),
                json.dumps(values["knowledge_context"], ensure_ascii=False),
            ),
        )
    return values


def get(session_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM draft_sessions WHERE id = ?", (session_id,)
        ).fetchone()
    return _decode(row)


def update(session_id: str, **fields) -> dict | None:
    clean = {k: v for k, v in fields.items() if k in _UPDATABLE}
    if not clean:
        return get(session_id)
    clean["updated_at"] = _now()
    encoded = {
        k: json.dumps(v, ensure_ascii=False) if k in _JSON_FIELDS else v
        for k, v in clean.items()
    }
    assignments = ", ".join(f"{k} = ?" for k in encoded)
    with _connect() as conn:
        conn.execute(
            f"UPDATE draft_sessions SET {assignments} WHERE id = ?",
            (*encoded.values(), session_id),
        )
    return get(session_id)


def delete(session_id: str) -> bool:
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM draft_sessions WHERE id = ?", (session_id,))
    return cursor.rowcount > 0


_init()
