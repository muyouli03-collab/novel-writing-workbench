"""本地小说创作项目、章节与知识条目存储。"""
from __future__ import annotations
import json
import difflib
import hashlib
import re
import shutil
import sqlite3
import time
import unicodedata
from contextlib import contextmanager, nullcontext
from pathlib import Path
from uuid import uuid4

import numpy as np

from .chunker import CHAPTER_RE

_ID_RE = re.compile(r"^p_[a-f0-9]{24}$")
_CHAPTER_ID_RE = re.compile(r"^ch_[a-f0-9]{24}$")
KNOWLEDGE_TYPES = {"scene", "plot", "character", "relationship", "term", "world", "clue"}
CARD_KNOWLEDGE_TYPES = tuple(sorted(KNOWLEDGE_TYPES - {"plot"}))
_TAG_CATALOG_ID = "knowledge_tag_catalog_v1"
RELATION_LAYOUT_MODES = {
    "hierarchy_source", "hierarchy_target", "opposition", "cluster", "sequence", "manual"
}


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def split_chapters(text: str) -> list[dict]:
    """按章节标题拆分全文；没有标题时保留为一个完整章节。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    result: list[dict] = []
    title = "正文"
    body: list[str] = []
    seen_heading = False

    def emit():
        nonlocal body
        content = "\n".join(body).strip()
        if content:
            result.append({"title": title, "text": content})
        body = []

    for raw in lines:
        line = raw.strip()
        if line and len(line) <= 80 and CHAPTER_RE.match(line):
            emit()
            title = line
            seen_heading = True
        else:
            body.append(raw)
    emit()
    if not result and text.strip():
        result = [{"title": "正文", "text": text.strip()}]
    if not seen_heading and len(result) == 1:
        result[0]["title"] = "正文"
    return result


def group_complete_chapters(chapters: list[dict], target_chars: int = 2000,
                            hard_max: int = 30000, max_chapters: int | None = None) -> list[list[dict]]:
    """按软目标组合完整章节，绝不切断章节。"""
    target_chars = min(max(int(target_chars), 500), hard_max)
    groups: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0
    for chapter in chapters:
        size = len(chapter.get("text") or "")
        if size > hard_max:
            raise ValueError(
                f"《{chapter.get('title') or '未命名章节'}》有 {size} 字，超过安全上限 {hard_max} 字，请先拆分章节"
            )
        if current and (current_len + size > target_chars
                        or (max_chapters is not None and len(current) >= max_chapters)):
            groups.append(current)
            current, current_len = [], 0
        current.append(chapter)
        current_len += size
        if current_len >= target_chars:
            groups.append(current)
            current, current_len = [], 0
    if current:
        groups.append(current)
    return groups


def required_plot_events(text: str) -> int:
    """Require a locator in every non-empty chapter, without asking the model to pad a quota.

    The model may select as many useful excerpts as the chapter needs.  A hard density quota
    encouraged filler and still could not prove that every event was represented; the invariant
    we can verify reliably is that no chapter silently disappears from the event chain.
    """
    return 1 if (text or "").strip() else 0


class ProjectStore:
    def __init__(self, base_dir: Path):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    def _validate_project_id(self, project_id: str) -> str:
        if not _ID_RE.fullmatch(project_id or ""):
            raise ValueError("项目编号无效")
        return project_id

    def project_dir(self, project_id: str) -> Path:
        self._validate_project_id(project_id)
        path = (self.base / project_id).resolve()
        if path.parent != self.base.resolve():
            raise ValueError("项目路径无效")
        return path

    def _meta_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "meta.json"

    def _db_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "project.db"

    @contextmanager
    def _connect(self, project_id: str):
        conn = sqlite3.connect(self._db_path(project_id), timeout=15)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self, project_id: str) -> None:
        with self._connect(project_id) as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS chapters (
                    id TEXT PRIMARY KEY,
                    position INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    knowledge_status TEXT NOT NULL DEFAULT 'dirty',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chapter_revisions (
                    id TEXT PRIMARY KEY,
                    chapter_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    position INTEGER NOT NULL,
                    knowledge_status TEXT NOT NULL,
                    change_kind TEXT NOT NULL DEFAULT 'edit',
                    created_at TEXT NOT NULL,
                    UNIQUE(chapter_id, version),
                    FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS knowledge_items (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}',
                    source_chapter_ids TEXT NOT NULL DEFAULT '[]',
                    source_quotes TEXT NOT NULL DEFAULT '[]',
                    order_start INTEGER NOT NULL DEFAULT 0,
                    review_status TEXT NOT NULL DEFAULT 'auto',
                    confidence REAL NOT NULL DEFAULT 0.5,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_batches (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    target_chars INTEGER NOT NULL,
                    chapter_ids TEXT NOT NULL,
                    draft_items TEXT NOT NULL DEFAULT '[]',
                    messages TEXT NOT NULL DEFAULT '[]',
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS research_notes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    query TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analysis_sessions (
                    session_id TEXT PRIMARY KEY,
                    chapter_id TEXT NOT NULL DEFAULT '',
                    knowledge_snapshot TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS knowledge_workspace_state (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ai_run_logs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    events TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chapter_position ON chapters(position);
                CREATE INDEX IF NOT EXISTS idx_chapter_revision ON chapter_revisions(chapter_id, version DESC);
                CREATE INDEX IF NOT EXISTS idx_knowledge_order ON knowledge_items(order_start);
                CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_items(type);
                CREATE INDEX IF NOT EXISTS idx_ai_run_updated ON ai_run_logs(updated_at DESC);
            """)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(knowledge_batches)")}
            if "chapter_versions" not in columns:
                conn.execute("ALTER TABLE knowledge_batches ADD COLUMN chapter_versions TEXT NOT NULL DEFAULT '{}'")
            if "context_info" not in columns:
                conn.execute("ALTER TABLE knowledge_batches ADD COLUMN context_info TEXT NOT NULL DEFAULT '{}'")
            self._repair_legacy_overbroad_invalidations(conn)

    @staticmethod
    def _repair_legacy_overbroad_invalidations(conn) -> None:
        """恢复旧逻辑误标的后续章节；正文版本真正变化的章节不会被恢复。"""
        chapters = {row["id"]: dict(row) for row in conn.execute(
            "SELECT id,version,knowledge_status FROM chapters"
        ).fetchall()}
        current_built = set()
        for row in conn.execute(
            "SELECT chapter_ids,chapter_versions FROM knowledge_batches WHERE status='done'"
        ).fetchall():
            try:
                ids = json.loads(row["chapter_ids"] or "[]")
                versions = json.loads(row["chapter_versions"] or "{}")
            except json.JSONDecodeError:
                continue
            current_built.update(cid for cid in ids if cid in chapters and versions.get(cid) == chapters[cid]["version"])
        if current_built:
            conn.executemany(
                "UPDATE chapters SET knowledge_status='indexed' WHERE id=? AND knowledge_status='needs_review'",
                [(cid,) for cid in current_built],
            )
        chapter_status = {row["id"]: row["knowledge_status"] for row in conn.execute(
            "SELECT id,knowledge_status FROM chapters"
        ).fetchall()}
        for row in conn.execute(
            "SELECT id,source_chapter_ids,review_status FROM knowledge_items "
            "WHERE active IN (1,-1,2) AND review_status IN ('needs_review','confirmed_needs_review')"
        ).fetchall():
            try:
                sources = [cid for cid in json.loads(row["source_chapter_ids"] or "[]") if cid in chapter_status]
            except json.JSONDecodeError:
                continue
            if sources and all(chapter_status[cid] == "indexed" for cid in sources):
                restored = "confirmed" if row["review_status"] == "confirmed_needs_review" else "auto"
                conn.execute("UPDATE knowledge_items SET review_status=?,updated_at=? WHERE id=?",
                             (restored, _now(), row["id"]))

    def create(self, name: str, **fields) -> dict:
        name = (name or "").strip()
        if not name:
            raise ValueError("项目名称不能为空")
        project_id = "p_" + uuid4().hex[:24]
        directory = self.project_dir(project_id)
        directory.mkdir(parents=True, exist_ok=False)
        now = _now()
        meta = {
            "id": project_id, "name": name[:120], "status": "empty",
            "concept": str(fields.get("concept") or "")[:20000],
            "characters": str(fields.get("characters") or "")[:20000],
            "worldbuilding": str(fields.get("worldbuilding") or "")[:20000],
            "style": str(fields.get("style") or "")[:10000],
            "current_goal": str(fields.get("current_goal") or "")[:10000],
            "reference_ids": [], "created_at": now, "updated_at": now,
            "knowledge_model": "", "knowledge_updated_at": "",
        }
        self._write_meta(project_id, meta)
        self._init_db(project_id)
        return meta

    def _write_meta(self, project_id: str, meta: dict) -> None:
        path = self._meta_path(project_id)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)

    def get(self, project_id: str) -> dict | None:
        path = self._meta_path(project_id)
        if not path.exists():
            return None
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        self._init_db(project_id)
        with self._connect(project_id) as conn:
            counts = conn.execute("SELECT COUNT(*), COALESCE(SUM(knowledge_status != 'indexed'),0) FROM chapters").fetchone()
        meta["chapter_count"], meta["dirty_count"] = counts[0], counts[1]
        return meta

    def list(self) -> list[dict]:
        projects = []
        for child in self.base.iterdir():
            if child.is_dir() and _ID_RE.fullmatch(child.name):
                project = self.get(child.name)
                if project:
                    projects.append(project)
        return sorted(projects, key=lambda item: item.get("updated_at", ""), reverse=True)

    def update(self, project_id: str, **fields) -> dict:
        meta = self.get(project_id)
        if not meta:
            raise KeyError(project_id)
        if "name" in fields and fields["name"] is not None and not str(fields["name"]).strip():
            raise ValueError("项目名称不能为空")
        allowed = {"name", "concept", "characters", "worldbuilding", "style", "current_goal"}
        for key in allowed:
            if key in fields and fields[key] is not None:
                limit = 120 if key == "name" else 20000
                old_value = meta.get(key, "")
                meta[key] = str(fields[key]).strip()[:limit]
                if key in (meta.get("setting_provenance") or {}) and meta[key] != old_value:
                    meta["setting_provenance"].pop(key, None)
        meta.pop("chapter_count", None)
        meta.pop("dirty_count", None)
        meta["updated_at"] = _now()
        self._write_meta(project_id, meta)
        return self.get(project_id)

    def set_references(self, project_id: str, reference_ids: list[str]) -> dict:
        meta = self.get(project_id)
        if not meta:
            raise KeyError(project_id)
        meta.pop("chapter_count", None)
        meta.pop("dirty_count", None)
        meta["reference_ids"] = list(dict.fromkeys(str(x) for x in reference_ids if x))[:20]
        meta["updated_at"] = _now()
        self._write_meta(project_id, meta)
        return self.get(project_id)

    def delete(self, project_id: str) -> bool:
        directory = self.project_dir(project_id)
        if not directory.exists():
            return False
        shutil.rmtree(directory)
        return True

    def add_research_note(self, project_id: str, title: str, query: str, payload: dict) -> dict:
        if not self.get(project_id):
            raise KeyError(project_id)
        note = {
            "id": "rn_" + uuid4().hex[:24],
            "title": str(title or "范本检索记录").strip()[:300],
            "query": str(query or "").strip()[:20000],
            "payload": payload if isinstance(payload, dict) else {},
            "created_at": _now(),
        }
        with self._connect(project_id) as conn:
            conn.execute(
                "INSERT INTO research_notes(id,title,query,payload,created_at) VALUES(?,?,?,?,?)",
                (note["id"], note["title"], note["query"],
                 json.dumps(note["payload"], ensure_ascii=False), note["created_at"]),
            )
        return note

    def list_research_notes(self, project_id: str) -> list[dict]:
        if not self.get(project_id):
            raise KeyError(project_id)
        with self._connect(project_id) as conn:
            rows = conn.execute(
                "SELECT * FROM research_notes ORDER BY created_at DESC, id DESC"
            ).fetchall()
        result = []
        for row in rows:
            note = dict(row)
            try:
                note["payload"] = json.loads(note["payload"] or "{}")
            except json.JSONDecodeError:
                note["payload"] = {}
            result.append(note)
        return result

    def link_analysis_session(self, project_id: str, session_id: str, chapter_id: str,
                              knowledge_snapshot: dict) -> None:
        if not self.get(project_id):
            raise KeyError(project_id)
        with self._connect(project_id) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO analysis_sessions(session_id,chapter_id,knowledge_snapshot,created_at) VALUES(?,?,?,?)",
                (session_id, chapter_id or "",
                 json.dumps(knowledge_snapshot or {}, ensure_ascii=False), _now()),
            )

    def list_analysis_sessions(self, project_id: str) -> list[dict]:
        if not self.get(project_id):
            raise KeyError(project_id)
        with self._connect(project_id) as conn:
            rows = conn.execute(
                "SELECT * FROM analysis_sessions ORDER BY created_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            try:
                item["knowledge_snapshot"] = json.loads(item["knowledge_snapshot"] or "{}")
            except json.JSONDecodeError:
                item["knowledge_snapshot"] = {}
            result.append(item)
        return result

    def list_chapters(self, project_id: str) -> list[dict]:
        self._init_db(project_id)
        with self._connect(project_id) as conn:
            rows = conn.execute("SELECT * FROM chapters ORDER BY position, created_at").fetchall()
        return [dict(row) for row in rows]

    def knowledge_chapter_choices(self, project_id: str) -> list[dict]:
        """选章面板返回目录、字数和剧情事件覆盖状态，不重复传输全文。"""
        self._init_db(project_id)
        with self._connect(project_id) as conn:
            rows = conn.execute("SELECT id,title,position,version,knowledge_status,LENGTH(text) AS char_count,"
                                "LENGTH(TRIM(text, char(9)||char(10)||char(13)||' ')) > 0 AS has_text "
                                "FROM chapters ORDER BY position,created_at").fetchall()
            batches = conn.execute("SELECT id,chapter_ids,chapter_versions FROM knowledge_batches "
                                   "WHERE status='done' ORDER BY rowid").fetchall()
        completed = {}
        built_ever = set()
        for batch in batches:
            versions = json.loads(batch["chapter_versions"] or "{}")
            for chapter_id in json.loads(batch["chapter_ids"] or "[]"):
                built_ever.add(chapter_id)
                completed[(chapter_id, versions.get(chapter_id))] = batch["id"]
        coverage = {row["id"]: row for row in self.plot_coverage(project_id)["chapters"]}
        return [dict(
            row,
            knowledge_batch_id=completed.get((row["id"], row["version"]), ""),
            plot_events=coverage.get(row["id"], {}).get("events", 0),
            plot_required=coverage.get(row["id"], {}).get("required", 0),
            plot_covered=(not row["has_text"] or bool(coverage.get(row["id"], {}).get("events", 0))),
            can_accept_existing_knowledge=(row["knowledge_status"] != "indexed" and bool(row["has_text"])
                                           and row["id"] in built_ever
                                           and bool(coverage.get(row["id"], {}).get("events", 0))),
        ) for row in rows]

    def accept_existing_chapter_knowledge(self, project_id: str,
                                          chapter_ids: list[str]) -> dict:
        """Accept previously built knowledge for edited chapters without invoking a model."""
        if not self.get(project_id):
            raise KeyError(project_id)
        requested = list(dict.fromkeys(str(value or "").strip() for value in chapter_ids
                                       if str(value or "").strip()))
        if not requested or len(requested) > 300:
            raise ValueError("请勾选1至300个只需沿用现有知识的章节")
        now = _now()
        restored_items = 0
        with self._connect(project_id) as conn:
            rows = conn.execute("SELECT id,text,knowledge_status FROM chapters").fetchall()
            chapters = {row["id"]: dict(row) for row in rows}
            missing = [chapter_id for chapter_id in requested if chapter_id not in chapters]
            if missing:
                raise KeyError(missing[0])
            if any(not str(chapters[chapter_id].get("text") or "").strip()
                   for chapter_id in requested):
                raise ValueError("空白章节不能标记为已建立")

            built_ever = set()
            for batch in conn.execute(
                "SELECT chapter_ids FROM knowledge_batches WHERE status='done'"
            ).fetchall():
                try:
                    built_ever.update(json.loads(batch["chapter_ids"] or "[]"))
                except (TypeError, json.JSONDecodeError):
                    continue
            plot_sources = set()
            for row in conn.execute(
                "SELECT source_chapter_ids,source_quotes FROM knowledge_items WHERE active=1 AND type='plot'"
            ).fetchall():
                try:
                    sources = json.loads(row["source_chapter_ids"] or "[]")
                    quotes = json.loads(row["source_quotes"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    continue
                for chapter_id in sources:
                    chapter = chapters.get(chapter_id)
                    if chapter and any(isinstance(quote, str) and quote
                                       and quote in str(chapter.get("text") or "") for quote in quotes):
                        plot_sources.add(chapter_id)
            unavailable = [chapter_id for chapter_id in requested
                           if chapter_id not in built_ever or chapter_id not in plot_sources]
            if unavailable:
                raise ValueError("只能沿用曾经成功建立且仍保留剧情事件的章节；其余章节需要正常建立知识库")

            conn.executemany(
                "UPDATE chapters SET knowledge_status='indexed',updated_at=? WHERE id=?",
                [(now, chapter_id) for chapter_id in requested],
            )
            chapter_status = {row["id"]: row["knowledge_status"] for row in conn.execute(
                "SELECT id,knowledge_status FROM chapters"
            ).fetchall()}
            for row in conn.execute(
                "SELECT id,source_chapter_ids,review_status FROM knowledge_items "
                "WHERE active IN (1,-1,2) AND review_status IN ('needs_review','confirmed_needs_review')"
            ).fetchall():
                try:
                    sources = [chapter_id for chapter_id in json.loads(row["source_chapter_ids"] or "[]")
                               if chapter_id in chapter_status]
                except (TypeError, json.JSONDecodeError):
                    continue
                if not sources or not set(sources).intersection(requested):
                    continue
                if all(chapter_status[chapter_id] == "indexed" for chapter_id in sources):
                    restored = ("confirmed" if row["review_status"] == "confirmed_needs_review"
                                else "auto")
                    conn.execute("UPDATE knowledge_items SET review_status=?,updated_at=? WHERE id=?",
                                 (restored, now, row["id"]))
                    restored_items += 1
        self._refresh_status(project_id)
        return {"chapter_ids": requested, "marked": len(requested),
                "restored_knowledge_items": restored_items}

    def get_chapter(self, project_id: str, chapter_id: str) -> dict | None:
        if not _CHAPTER_ID_RE.fullmatch(chapter_id or ""):
            return None
        # 允许服务重启后直接保存旧项目；此处确保版本表迁移已完成。
        self._init_db(project_id)
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        return dict(row) if row else None

    def add_chapter(self, project_id: str, title: str = "", text: str = "",
                    position: int | None = None) -> dict:
        chapters = self.list_chapters(project_id)
        if position is None:
            position = len(chapters) + 1
        position = max(1, min(int(position), len(chapters) + 1))
        chapter_id = "ch_" + uuid4().hex[:24]
        now = _now()
        with self._connect(project_id) as conn:
            conn.execute("UPDATE chapters SET position = position + 1, version=version+1 WHERE position >= ?", (position,))
            conn.execute(
                "INSERT INTO chapters(id, position, title, text, version, knowledge_status, created_at, updated_at) VALUES(?,?,?,?,1,'dirty',?,?)",
                (chapter_id, position, (title or f"第{position}章")[:200], text or "", now, now),
            )
            self._invalidate_from(conn, position)
        self._refresh_status(project_id)
        return self.get_chapter(project_id, chapter_id)

    def update_chapter(self, project_id: str, chapter_id: str, title=None, text=None,
                       position=None, *, change_kind: str = "edit") -> dict:
        current = self.get_chapter(project_id, chapter_id)
        if not current:
            raise KeyError(chapter_id)
        content_changed = ((text is not None and str(text) != current["text"])
                           or (title is not None and str(title).strip() != current["title"]))
        position_changed = position is not None and int(position) != current["position"]
        changed_text = content_changed or position_changed
        values = {
            "title": current["title"] if title is None else str(title).strip()[:200],
            "text": current["text"] if text is None else str(text),
            "position": current["position"] if position is None else max(1, int(position)),
            "updated_at": _now(),
            "version": current["version"] + (1 if changed_text else 0),
            "knowledge_status": "dirty" if changed_text else current["knowledge_status"],
        }
        chapter_count = len(self.list_chapters(project_id))
        with self._connect(project_id) as conn:
            if changed_text:
                self._save_chapter_revision(conn, current, change_kind)
            new_position = min(values["position"], max(1, chapter_count))
            old_position = current["position"]
            if new_position < old_position:
                conn.execute(
                    "UPDATE chapters SET position=position+1, version=version+1 WHERE position>=? AND position<? AND id<>?",
                    (new_position, old_position, chapter_id),
                )
            elif new_position > old_position:
                conn.execute(
                    "UPDATE chapters SET position=position-1, version=version+1 WHERE position>? AND position<=? AND id<>?",
                    (old_position, new_position, chapter_id),
                )
            values["position"] = new_position
            conn.execute(
                "UPDATE chapters SET title=?, text=?, position=?, version=?, knowledge_status=?, updated_at=? WHERE id=?",
                (values["title"], values["text"], values["position"], values["version"],
                 values["knowledge_status"], values["updated_at"], chapter_id),
            )
            if position_changed:
                # 调整目录位置会改变一段章节的时间边界，继续采用保守复核。
                self._invalidate_from(conn, min(old_position, new_position))
            elif content_changed:
                # 正文/标题修改只使本章及真正引用本章的知识失效；后文只进入影响报告。
                self._invalidate_chapter_knowledge(conn, chapter_id, current["text"])
        self._refresh_status(project_id)
        return self.get_chapter(project_id, chapter_id)

    @staticmethod
    def _invalidate_chapter_knowledge(conn, chapter_id: str, previous_text: str) -> None:
        for row in conn.execute(
            "SELECT id,source_chapter_ids,source_quotes,review_status FROM knowledge_items WHERE active IN (1,-1,2)"
        ).fetchall():
            try:
                sources = set(json.loads(row["source_chapter_ids"] or "[]"))
                quotes = [quote for quote in json.loads(row["source_quotes"] or "[]")
                          if isinstance(quote, str) and quote]
            except json.JSONDecodeError:
                continue
            if chapter_id not in sources:
                continue
            # 兼容旧批次把整批章节都写为来源的情况：有引文时，只认旧正文中实际出现的引文。
            if quotes and not any(quote in previous_text for quote in quotes):
                continue
            status = "confirmed_needs_review" if row["review_status"].startswith("confirmed") else "needs_review"
            conn.execute("UPDATE knowledge_items SET review_status=?,updated_at=? WHERE id=?",
                         (status, _now(), row["id"]))

    @staticmethod
    def _save_chapter_revision(conn, chapter: dict, change_kind: str = "edit") -> None:
        """在覆盖章节前保存完整快照；同一版本只会保存一次。"""
        conn.execute(
            "INSERT OR IGNORE INTO chapter_revisions(id,chapter_id,version,title,text,position,knowledge_status,change_kind,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            ("cr_" + uuid4().hex[:24], chapter["id"], int(chapter["version"]), chapter["title"],
             chapter["text"], int(chapter["position"]), chapter["knowledge_status"],
             str(change_kind or "edit")[:30], _now()),
        )
        # 自动保存可能产生很多版本。每章保留最近 50 个旧版本，避免正文数据库无限增长。
        conn.execute(
            "DELETE FROM chapter_revisions WHERE chapter_id=? AND id NOT IN "
            "(SELECT id FROM chapter_revisions WHERE chapter_id=? ORDER BY version DESC LIMIT 50)",
            (chapter["id"], chapter["id"]),
        )

    def list_chapter_versions(self, project_id: str, chapter_id: str) -> list[dict]:
        current = self.get_chapter(project_id, chapter_id)
        if not current:
            raise KeyError(chapter_id)
        with self._connect(project_id) as conn:
            rows = conn.execute(
                "SELECT id,version,title,position,knowledge_status,change_kind,created_at,LENGTH(text) AS char_count "
                "FROM chapter_revisions WHERE chapter_id=? ORDER BY version DESC", (chapter_id,),
            ).fetchall()
        result = [{"id": "current", "version": current["version"], "title": current["title"],
                   "position": current["position"], "knowledge_status": current["knowledge_status"],
                   "change_kind": "current", "created_at": current["updated_at"],
                   "char_count": len(current["text"]), "current": True}]
        result.extend(dict(row, current=False) for row in rows)
        return result

    def compare_chapter_version(self, project_id: str, chapter_id: str, version: int) -> dict:
        current = self.get_chapter(project_id, chapter_id)
        if not current:
            raise KeyError(chapter_id)
        with self._connect(project_id) as conn:
            old = conn.execute(
                "SELECT * FROM chapter_revisions WHERE chapter_id=? AND version=?", (chapter_id, int(version)),
            ).fetchone()
            rows = conn.execute(
                "SELECT id,type,title,summary,source_quotes,review_status FROM knowledge_items "
                "WHERE active=1 AND source_chapter_ids LIKE ? ORDER BY order_start,id", (f'%"{chapter_id}"%',),
            ).fetchall()
            later = conn.execute(
                "SELECT id,title,position,knowledge_status FROM chapters WHERE position>? ORDER BY position",
                (current["position"],),
            ).fetchall()
        if not old:
            raise KeyError(f"version:{version}")
        old = dict(old)
        old_lines, new_lines = old["text"].splitlines(), current["text"].splitlines()
        matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
        changes = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            changes.append({"kind": tag, "old_start": i1 + 1, "old_end": i2,
                            "new_start": j1 + 1, "new_end": j2,
                            "old_text": "\n".join(old_lines[i1:i2])[:6000],
                            "new_text": "\n".join(new_lines[j1:j2])[:6000]})
        affected = []
        for row in rows:
            item = dict(row)
            try:
                quotes = [q for q in json.loads(item.pop("source_quotes") or "[]") if isinstance(q, str) and q]
            except json.JSONDecodeError:
                quotes = []
            item["quotes_total"] = len(quotes)
            item["quotes_missing"] = sum(1 for quote in quotes if quote not in current["text"])
            affected.append(item)
        return {
            "chapter_id": chapter_id, "old_version": int(version), "current_version": current["version"],
            "old_title": old["title"], "current_title": current["title"],
            "old_text": old["text"], "current_text": current["text"], "changes": changes,
            "affected_knowledge": affected, "later_chapters": [dict(row) for row in later],
        }

    def restore_chapter_version(self, project_id: str, chapter_id: str, version: int) -> dict:
        current = self.get_chapter(project_id, chapter_id)
        if not current:
            raise KeyError(chapter_id)
        with self._connect(project_id) as conn:
            old = conn.execute(
                "SELECT title,text FROM chapter_revisions WHERE chapter_id=? AND version=?", (chapter_id, int(version)),
            ).fetchone()
        if not old:
            raise KeyError(f"version:{version}")
        # 恢复正文和标题，不恢复旧目录位置，防止意外打乱后来调整过的章节顺序。
        return self.update_chapter(project_id, chapter_id, title=old["title"], text=old["text"],
                                   change_kind="restore")

    def delete_chapter(self, project_id: str, chapter_id: str) -> bool:
        chapter = self.get_chapter(project_id, chapter_id)
        if not chapter:
            return False
        with self._connect(project_id) as conn:
            self._invalidate_from(conn, chapter["position"])
            conn.execute("DELETE FROM chapters WHERE id=?", (chapter_id,))
            conn.execute("UPDATE chapters SET position=position-1, version=version+1 WHERE position>?", (chapter["position"],))
        self._refresh_status(project_id)
        return True

    @staticmethod
    def _invalidate_from(conn, position: int) -> None:
        affected = {row[0] for row in conn.execute("SELECT id FROM chapters WHERE position>=?", (position,))}
        conn.execute("UPDATE chapters SET knowledge_status='needs_review' WHERE position>=? AND knowledge_status='indexed'", (position,))
        # 回收站条目也要追踪正文变化，防止恢复后把旧理解当作当前事实。
        for row in conn.execute("SELECT id,source_chapter_ids,review_status FROM knowledge_items WHERE active IN (1,-1,2)").fetchall():
            if affected.intersection(json.loads(row["source_chapter_ids"] or "[]")):
                status = "confirmed_needs_review" if row["review_status"].startswith("confirmed") else "needs_review"
                conn.execute("UPDATE knowledge_items SET review_status=?,updated_at=? WHERE id=?", (status, _now(), row["id"]))

    def import_chapters(self, project_id: str, text: str) -> list[dict]:
        parsed = split_chapters(text)
        if not parsed:
            raise ValueError("导入文件没有可用正文")
        existing = self.list_chapters(project_id)
        if len(existing) == 1 and not (existing[0].get("text") or "").strip():
            self.delete_chapter(project_id, existing[0]["id"])
            existing = []
        now = _now()
        rows = [("ch_" + uuid4().hex[:24], len(existing) + index, item["title"][:200], item["text"], now, now)
                for index, item in enumerate(parsed, 1)]
        with self._connect(project_id) as conn:
            conn.executemany("INSERT INTO chapters(id,position,title,text,version,knowledge_status,created_at,updated_at) VALUES(?,?,?,?,1,'dirty',?,?)", rows)
        self._refresh_status(project_id)
        return self.list_chapters(project_id)

    def create_batch(self, project_id: str, mode: str, target_chars: int,
                     chapters: list[dict]) -> dict:
        batch_id = "kb_" + uuid4().hex[:24]
        now = _now()
        values = {
            "id": batch_id, "mode": mode, "status": "running",
            "target_chars": int(target_chars),
            "chapter_ids": [c["id"] for c in chapters], "draft_items": [],
            "messages": [], "error": "", "created_at": now, "updated_at": now,
            "chapter_versions": {c["id"]: c["version"] for c in chapters},
        }
        with self._connect(project_id) as conn:
            conn.execute(
                "INSERT INTO knowledge_batches(id,mode,status,target_chars,chapter_ids,draft_items,messages,error,created_at,updated_at,chapter_versions) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (batch_id, mode, "running", int(target_chars),
                 json.dumps(values["chapter_ids"], ensure_ascii=False), "[]", "[]", "", now, now,
                 json.dumps(values["chapter_versions"])),
            )
        return values

    def update_batch(self, project_id: str, batch_id: str, **fields) -> dict | None:
        allowed = {"status", "draft_items", "messages", "error", "context_info"}
        clean = {key: value for key, value in fields.items() if key in allowed}
        clean["updated_at"] = _now()
        encoded = {key: json.dumps(value, ensure_ascii=False) if key in {"draft_items", "messages", "context_info"} else value
                   for key, value in clean.items()}
        with self._connect(project_id) as conn:
            conn.execute(
                "UPDATE knowledge_batches SET " + ",".join(f"{key}=?" for key in encoded) + " WHERE id=?",
                (*encoded.values(), batch_id),
            )
            row = conn.execute("SELECT * FROM knowledge_batches WHERE id=?", (batch_id,)).fetchone()
        return self._decode_batch(row)

    def get_batch(self, project_id: str, batch_id: str) -> dict | None:
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT * FROM knowledge_batches WHERE id=?", (batch_id,)).fetchone()
        return self._decode_batch(row)

    def pending_batches(self, project_id: str) -> list[dict]:
        with self._connect(project_id) as conn:
            rows = conn.execute("SELECT * FROM knowledge_batches WHERE status='awaiting_review' ORDER BY created_at").fetchall()
        return [self._decode_batch(row) for row in rows]

    def batch_is_current(self, project_id: str, batch: dict) -> bool:
        chapters = {c["id"]: c for c in self.list_chapters(project_id)}
        versions = batch.get("chapter_versions") or {}
        return bool(versions) and all(cid in chapters and chapters[cid]["version"] == version for cid, version in versions.items())

    @staticmethod
    def _decode_batch(row) -> dict | None:
        if not row:
            return None
        item = dict(row)
        for key in ("chapter_ids", "draft_items", "messages"):
            try:
                item[key] = json.loads(item[key] or "[]")
            except json.JSONDecodeError:
                item[key] = []
        item["chapter_versions"] = json.loads(item.get("chapter_versions") or "{}")
        item["context_info"] = json.loads(item.get("context_info") or "{}")
        return item

    @staticmethod
    def _decode_ai_run(row, include_events: bool = True) -> dict | None:
        if not row:
            return None
        item = dict(row)
        try:
            item["metadata"] = json.loads(item.get("metadata") or "{}")
        except (TypeError, json.JSONDecodeError):
            item["metadata"] = {}
        if include_events:
            try:
                item["events"] = json.loads(item.get("events") or "[]")
            except (TypeError, json.JSONDecodeError):
                item["events"] = []
        else:
            item.pop("events", None)
        return item

    @staticmethod
    def _ai_run_json(value) -> str:
        return json.dumps(value, ensure_ascii=False, default=str)

    def create_ai_run(self, project_id: str, run_id: str, kind: str, title: str,
                      metadata: dict | None = None) -> dict:
        """Create a persistent, project-local trace. Credentials are never passed here."""
        self._init_db(project_id)
        now = _now()
        with self._connect(project_id) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO ai_run_logs(id,kind,status,title,summary,metadata,events,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (str(run_id), str(kind)[:80], "running", str(title)[:200], "",
                 self._ai_run_json(metadata or {}), "[]", now, now),
            )
            # The trace is diagnostic history rather than novel knowledge. Keep it bounded.
            conn.execute("DELETE FROM ai_run_logs WHERE id NOT IN "
                         "(SELECT id FROM ai_run_logs ORDER BY updated_at DESC, rowid DESC LIMIT 50)")
            row = conn.execute("SELECT * FROM ai_run_logs WHERE id=?", (str(run_id),)).fetchone()
        return self._decode_ai_run(row)

    def append_ai_run_event(self, project_id: str, run_id: str, stage: str, title: str,
                            summary: str = "", data=None) -> dict | None:
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT events FROM ai_run_logs WHERE id=?", (str(run_id),)).fetchone()
            if not row:
                return None
            try:
                events = json.loads(row["events"] or "[]")
            except (TypeError, json.JSONDecodeError):
                events = []
            event = {
                "id": "ae_" + uuid4().hex[:16], "time": _now(),
                "stage": str(stage or "info")[:60], "title": str(title or "运行记录")[:200],
                "summary": str(summary or "")[:4000], "data": data,
            }
            events = events[-399:] + [event]
            conn.execute("UPDATE ai_run_logs SET events=?,updated_at=? WHERE id=?",
                         (self._ai_run_json(events), _now(), str(run_id)))
        return event

    def finish_ai_run(self, project_id: str, run_id: str, status: str,
                      summary: str = "") -> dict | None:
        status = status if status in {"done", "error", "interrupted"} else "done"
        with self._connect(project_id) as conn:
            conn.execute("UPDATE ai_run_logs SET status=?,summary=?,updated_at=? WHERE id=?",
                         (status, str(summary or "")[:4000], _now(), str(run_id)))
            row = conn.execute("SELECT * FROM ai_run_logs WHERE id=?", (str(run_id),)).fetchone()
        return self._decode_ai_run(row)

    def list_ai_runs(self, project_id: str, kind: str = "", limit: int = 20) -> list[dict]:
        self._init_db(project_id)
        limit = min(max(int(limit), 1), 50)
        with self._connect(project_id) as conn:
            if kind:
                rows = conn.execute("SELECT * FROM ai_run_logs WHERE kind=? "
                                    "ORDER BY updated_at DESC,rowid DESC LIMIT ?", (kind, limit)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM ai_run_logs ORDER BY updated_at DESC,rowid DESC LIMIT ?",
                                    (limit,)).fetchall()
        return [self._decode_ai_run(row, include_events=False) for row in rows]

    def get_ai_run(self, project_id: str, run_id: str) -> dict | None:
        self._init_db(project_id)
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT * FROM ai_run_logs WHERE id=?", (str(run_id),)).fetchone()
        return self._decode_ai_run(row)

    def save_knowledge(self, project_id: str, items: list[dict], chapter_ids: list[str],
                       review_status: str, *, append_only: bool = False,
                       merge_same_name: bool = True, trust_source_metadata: bool = False,
                       _conn=None) -> list[dict]:
        chapters = {c["id"]: dict(c) for c in (_conn.execute("SELECT * FROM chapters").fetchall() if _conn is not None else self.list_chapters(project_id))}
        valid_chapters = [cid for cid in chapter_ids if cid in chapters]
        items, _ = self.prepare_generated_knowledge(items, [chapters[cid] for cid in valid_chapters])
        saved = []
        now = _now()
        with (nullcontext(_conn) if _conn is not None else self._connect(project_id)) as conn:
            # 同一来源章节的旧AI条目失效；用户确认过的条目保留，等待人工复核。
            rows = conn.execute(
                "SELECT id,type,source_chapter_ids,source_quotes,review_status FROM knowledge_items WHERE active=1"
            ).fetchall() if not append_only else []
            for row in rows:
                try:
                    sources = set(json.loads(row["source_chapter_ids"] or "[]"))
                except json.JSONDecodeError:
                    sources = set()
                try:
                    old_quotes = [quote for quote in json.loads(row["source_quotes"] or "[]")
                                  if isinstance(quote, str) and quote]
                except json.JSONDecodeError:
                    old_quotes = []
                # 旧版把条目来源写成整批章节。能用引文精确定位时，仅按真正含引文的章节判断替换范围。
                located_sources = {cid for cid in sources if cid in chapters
                                   and any(quote in chapters[cid]["text"] for quote in old_quotes)}
                if located_sources:
                    sources = located_sources
                if (sources.intersection(valid_chapters)
                        and (row["type"] == "plot" or row["review_status"] not in {"confirmed", "confirmed_needs_review"})):
                    conn.execute("UPDATE knowledge_items SET active=0,updated_at=? WHERE id=?", (now, row["id"]))
            # 非剧情卡片先按“大类 + 规范化标题”建立精确命中表。它只处理真正同名，
            # 不用相似度猜测身份，避免把同名人物或不同概念错误合并。
            existing_by_id, existing_by_name = {}, {}
            if merge_same_name:
                for stored in conn.execute("SELECT * FROM knowledge_items WHERE active=1 AND type!='plot'").fetchall():
                    row = dict(stored)
                    try:
                        details = json.loads(row.get("details") or "{}")
                    except (TypeError, json.JSONDecodeError):
                        details = {}
                    existing_by_id[row["id"]] = stored
                    for key in self._knowledge_identity_keys(row["title"], details):
                        existing_by_name.setdefault((row["type"], key), set()).add(row["id"])
            for raw in items[:200]:
                if not isinstance(raw, dict):
                    continue
                item_type = str(raw.get("type") or "scene").lower()
                if item_type not in KNOWLEDGE_TYPES:
                    item_type = "scene"
                # 逐步确认时，用户可以明确要求把同名草稿另存为独立卡片。
                # 这里同时跳过同名归并并强制使用新 ID，避免客户端草稿意外沿用旧卡片 ID。
                save_as_separate = item_type != "plot" and raw.get("save_as_separate") is True
                summary = str(raw.get("summary") or raw.get("description") or "").strip()[:4000]
                if not summary:
                    continue
                raw_quotes = raw.get("source_quotes") or []
                if not isinstance(raw_quotes, list):
                    raw_quotes = []
                candidate_quotes = [str(q).strip()[:800] for q in raw_quotes if isinstance(q, str) and q.strip()]
                quotes, item_chapter_ids = [], []
                if trust_source_metadata:
                    # 仅供“由已保存卡片生成显式合并结果”使用。来源已由原卡片提供，
                    # 此处不再把旧章节映射或格式差异误判成模型伪造引文。
                    quotes = list(dict.fromkeys(candidate_quotes))[:8]
                    item_chapter_ids = list(valid_chapters)
                else:
                    for quote in candidate_quotes:
                        for cid in valid_chapters:
                            if quote in chapters[cid]["text"]:
                                if quote not in quotes:
                                    quotes.append(quote)
                                if cid not in item_chapter_ids:
                                    item_chapter_ids.append(cid)
                                break
                        if len(quotes) >= 8:
                            break
                    if not quotes:
                        continue
                order_start = min((chapters[cid]["position"] for cid in item_chapter_ids), default=0)
                try:
                    confidence = min(max(float(raw.get("confidence") or 0.6), 0.0), 1.0)
                except (ValueError, TypeError):
                    confidence = 0.6
                item_details = self._normalize_knowledge_details(
                    item_type, raw.get("details") if isinstance(raw.get("details"), dict) else {},
                )
                if (item_type == "plot" and item_details.get("event_type") == "character_state_change"
                        and str(review_status).startswith("confirmed")):
                    item_details["interpretation_status"] = "confirmed"
                item = {
                    "id": "ki_" + uuid4().hex[:24] if save_as_separate else str(raw.get("id") or "ki_" + uuid4().hex[:24]),
                    "type": item_type,
                    "title": str(raw.get("title") or raw.get("name") or "").strip()[:300],
                    "summary": summary,
                    "details": item_details,
                    "source_chapter_ids": item_chapter_ids,
                    "source_quotes": quotes,
                    "order_start": order_start, "review_status": review_status,
                    "confidence": confidence,
                    "active": 1, "created_at": now, "updated_at": now,
                }
                exact_key = self._knowledge_title_key(item["title"])
                candidates = set(existing_by_name.get((item_type, exact_key), set())) if exact_key else set()
                if len(candidates) != 1:
                    keys = self._knowledge_identity_keys(item["title"], item["details"])
                    candidates = set().union(*(existing_by_name.get((item_type, key), set()) for key in keys)) if keys else set()
                same_name = (existing_by_id[next(iter(candidates))]
                             if not save_as_separate and len(candidates) == 1 else None)
                if same_name is not None:
                    existing = dict(same_name)
                    for key, fallback in (("details", {}), ("source_chapter_ids", []), ("source_quotes", [])):
                        try:
                            existing[key] = json.loads(existing[key] or json.dumps(fallback))
                        except (TypeError, json.JSONDecodeError):
                            existing[key] = fallback
                    item = self._merge_same_name_knowledge(existing, item, chapters, now)
                    conn.execute(
                        "UPDATE knowledge_items SET summary=?,details=?,source_chapter_ids=?,source_quotes=?,"
                        "order_start=?,review_status=?,confidence=?,updated_at=? WHERE id=? AND active=1",
                        (item["summary"], json.dumps(item["details"], ensure_ascii=False),
                         json.dumps(item["source_chapter_ids"], ensure_ascii=False),
                         json.dumps(item["source_quotes"], ensure_ascii=False), item["order_start"],
                         item["review_status"], item["confidence"], now, item["id"]),
                    )
                    refreshed = conn.execute("SELECT * FROM knowledge_items WHERE id=?", (item["id"],)).fetchone()
                    existing_by_id[item["id"]] = refreshed
                    saved.append(item)
                    continue
                stable_existing = conn.execute(
                    "SELECT * FROM knowledge_items WHERE id=?", (item["id"],)
                ).fetchone() if item_type == "plot" else None
                if stable_existing is not None:
                    old = dict(stable_existing)
                    try:
                        old_details = json.loads(old.get("details") or "{}")
                    except (TypeError, json.JSONDecodeError):
                        old_details = {}
                    if old_details.get("user_note") and not item["details"].get("user_note"):
                        item["details"]["user_note"] = old_details["user_note"]
                    if str(old.get("review_status") or "").startswith("confirmed"):
                        # Stable source identity means the quotation did not change.  Refresh only
                        # deterministic locator metadata; never let a fresh model interpretation
                        # overwrite fields that the user already reviewed for this exact excerpt.
                        reviewed_fields = {
                            "event_type", "affected_character_titles", "state_key", "state_before",
                            "state_after", "change_reason", "persistence", "interpretation_status",
                        }
                        for key in reviewed_fields:
                            if key in old_details:
                                item["details"][key] = old_details[key]
                        # 相同证据再次生成时，保护用户已经核对、修改过的剧情概括。
                        item["title"] = old.get("title") or item["title"]
                        item["summary"] = old.get("summary") or item["summary"]
                        item["review_status"] = "confirmed"
                    conn.execute(
                        "UPDATE knowledge_items SET type=?,title=?,summary=?,details=?,source_chapter_ids=?,"
                        "source_quotes=?,order_start=?,review_status=?,confidence=?,active=1,updated_at=? WHERE id=?",
                        (item["type"], item["title"], item["summary"],
                         json.dumps(item["details"], ensure_ascii=False),
                         json.dumps(item_chapter_ids, ensure_ascii=False),
                         json.dumps(item["source_quotes"], ensure_ascii=False), order_start,
                         item["review_status"], item["confidence"], now, item["id"]),
                    )
                    saved.append(item)
                    continue
                conn.execute(
                    "INSERT INTO knowledge_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (item["id"], item["type"], item["title"], item["summary"],
                     json.dumps(item["details"], ensure_ascii=False),
                     json.dumps(item_chapter_ids, ensure_ascii=False),
                     json.dumps(item["source_quotes"], ensure_ascii=False), order_start,
                     review_status, item["confidence"], 1, now, now),
                )
                saved.append(item)
                if item_type != "plot" and not save_as_separate:
                    stored = conn.execute("SELECT * FROM knowledge_items WHERE id=?", (item["id"],)).fetchone()
                    existing_by_id[item["id"]] = stored
                    for key in self._knowledge_identity_keys(item["title"], item["details"]):
                        existing_by_name.setdefault((item_type, key), set()).add(item["id"])
            # 同一批若模型自己输出了两条同名卡片，调用方也只看到最终的一张。
            saved = list({item["id"]: item for item in saved}.values())
            if items and not saved:
                raise ValueError("知识条目缺少可在本批正文定位的原文依据，请重新生成或修正引用")
            if valid_chapters and not append_only:
                placeholders = ",".join("?" for _ in valid_chapters)
                conn.execute(
                    f"UPDATE chapters SET knowledge_status='indexed', updated_at=? WHERE id IN ({placeholders})",
                    (now, *valid_chapters),
                )
        if _conn is None:
            self._refresh_status(project_id, indexed=not append_only)
            if any(item["type"] in {"clue", "plot"} for item in saved):
                from .clues import ClueStore
                ClueStore(self, project_id).match({item["id"] for item in saved})
        return saved

    def create_manual_knowledge(self, project_id: str, item_type: str, title: str, summary: str,
                                source_chapter_ids: list[str] | None = None,
                                source_quotes: list[str] | None = None) -> dict:
        """Create one user-authored card without invoking or deduplicating through a model."""
        if not self.get(project_id):
            raise KeyError(project_id)
        item_type = str(item_type or "").strip().lower()
        if item_type not in CARD_KNOWLEDGE_TYPES:
            raise ValueError("手动新增只支持人物、关系、名词、世界观、场景或伏笔；剧情请在剧情索引中建立")
        title = str(title or "").strip()
        summary = str(summary or "").strip()
        if not title or len(title) > 300:
            raise ValueError("卡片标题必填，最多300字")
        if not summary or len(summary) > 4000:
            raise ValueError("卡片内容必填，最多4000字")

        chapters = {chapter["id"]: chapter for chapter in self.list_chapters(project_id)}
        requested_ids = list(dict.fromkeys(str(value) for value in (source_chapter_ids or []) if str(value)))
        if len(requested_ids) > 20 or any(chapter_id not in chapters for chapter_id in requested_ids):
            raise ValueError("来源章节不存在或数量过多，请刷新后重新选择")
        candidates = [chapters[chapter_id] for chapter_id in requested_ids] if requested_ids else list(chapters.values())
        quotes, located_ids = [], []
        for value in source_quotes or []:
            quote = str(value or "").strip()
            if not quote:
                continue
            if len(quote) > 800:
                raise ValueError("每段来源原文最多800字；较长内容请拆成多段，并用空行分隔")
            matches = [(chapter, self._locate_source_quote_fragments(chapter.get("text") or "", quote))
                       for chapter in candidates]
            matches = [(chapter, exact_parts) for chapter, exact_parts in matches if exact_parts]
            if not matches:
                scope = "所选章节" if requested_ids else "小说正文"
                raise ValueError(f"有一段来源原文无法在{scope}中定位，或删减后的文字顺序与原文不一致，请检查后重试")
            chapter, exact_parts = matches[0]
            for exact in exact_parts:
                if exact not in quotes:
                    quotes.append(exact)
            if len(quotes) > 8:
                raise ValueError("删减后的引文拆分为超过8段原文，请合并或减少后重试")
            if chapter["id"] not in located_ids:
                located_ids.append(chapter["id"])
        chapter_ids = list(dict.fromkeys([*requested_ids, *located_ids]))
        order_start = min((int(chapters[chapter_id]["position"]) for chapter_id in chapter_ids), default=0)
        now = _now()
        item_id = "ki_" + uuid4().hex[:24]
        details = self._normalize_knowledge_details(item_type, {
            "manual_created": True,
            "manual_scope": "chapter" if chapter_ids else "project",
        })
        with self._connect(project_id) as conn:
            conn.execute(
                "INSERT INTO knowledge_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (item_id, item_type, title, summary, json.dumps(details, ensure_ascii=False),
                 json.dumps(chapter_ids, ensure_ascii=False), json.dumps(quotes, ensure_ascii=False),
                 order_start, "confirmed", 1.0, 1, now, now),
            )
        item = next(entry for entry in self.list_knowledge(project_id) if entry["id"] == item_id)
        if item_type == "clue":
            from .clues import ClueStore
            ClueStore(self, project_id).match({item_id})
        return item

    @staticmethod
    def _source_event_id(chapter_id: str, quote: str) -> str:
        value = hashlib.sha256(f"{chapter_id}\0{quote}".encode("utf-8")).hexdigest()[:24]
        return "ki_" + value

    @staticmethod
    def _quote_content_with_offsets(value: str) -> tuple[str, list[int]]:
        """Normalize presentation punctuation while retaining manuscript offsets."""
        content, offsets = [], []
        for index, char in enumerate(str(value or "")):
            # Quote editors commonly change line wrapping, indentation and Chinese/ASCII
            # punctuation.  Those are presentation details; the actual words must still
            # occur in the manuscript in the same order.
            if char.isspace() or unicodedata.category(char).startswith("P"):
                continue
            normalized = unicodedata.normalize("NFKC", char)
            for normalized_char in normalized:
                content.append(normalized_char)
                offsets.append(index)
        return "".join(content), offsets

    @staticmethod
    def _locate_source_quote(text: str, candidate: str) -> str:
        """Return the exact manuscript span while tolerating whitespace-only changes."""
        source = str(text or "")
        wanted = str(candidate or "").strip()
        if not source or not wanted:
            return ""
        offset = source.find(wanted)
        if offset >= 0:
            return source[offset:offset + len(wanted)]

        compact_wanted = "".join(char for char in wanted if not char.isspace())
        if len(compact_wanted) < 4:
            return ""
        compact_source, offsets = [], []
        for index, char in enumerate(source):
            if not char.isspace():
                compact_source.append(char)
                offsets.append(index)
        compact_source = "".join(compact_source)
        compact_offset = compact_source.find(compact_wanted)
        if compact_offset < 0:
            return ""
        start = offsets[compact_offset]
        end = offsets[compact_offset + len(compact_wanted) - 1] + 1
        return source[start:end].strip()

    @classmethod
    def _locate_flexible_source_quote(cls, text: str, candidate: str) -> str:
        """Locate a knowledge-card quote while ignoring presentation punctuation."""
        source = str(text or "")
        wanted = str(candidate or "").strip()
        if not source or not wanted:
            return ""
        if exact := cls._locate_source_quote(source, wanted):
            return exact

        compact_wanted, _ = cls._quote_content_with_offsets(wanted)
        if len(compact_wanted) < 4:
            return ""
        compact_source, offsets = cls._quote_content_with_offsets(source)
        compact_offset = compact_source.find(compact_wanted)
        if compact_offset < 0:
            return ""
        start = offsets[compact_offset]
        end = offsets[compact_offset + len(compact_wanted) - 1] + 1
        opening = set("\"'“‘「『【（([《〈")
        closing = set("\"'”’」』】）)]》〉，。！？；：、,.!?;:…")
        while start > 0 and source[start - 1] in opening:
            start -= 1
        while end < len(source) and source[end] in closing:
            end += 1
        return source[start:end].strip()

    @classmethod
    def _locate_source_quote_fragments(cls, text: str, candidate: str) -> list[str]:
        """Locate edited citations, splitting out omitted narrative between kept sentences.

        A user may remove an unrelated speech action from the middle of an AI-selected
        paragraph.  Every retained sentence still has to occur in one chapter and in the
        original order; successful matches are returned as separate exact manuscript spans.
        """
        source = str(text or "")
        wanted = str(candidate or "").strip()
        if not source or not wanted:
            return []
        if exact := cls._locate_flexible_source_quote(source, wanted):
            return [exact]

        raw_parts = re.split(r"(?:\r?\n)+|(?<=[。！？!?；;])", wanted)
        parts = []
        for raw_part in raw_parts:
            part = str(raw_part or "").strip()
            content, _ = cls._quote_content_with_offsets(part)
            if len(content) >= 4:
                parts.append(part)
        if len(parts) < 2:
            return []

        exact_parts, cursor = [], 0
        for part in parts:
            exact = cls._locate_flexible_source_quote(source[cursor:], part)
            if not exact:
                return []
            relative = source[cursor:].find(exact)
            if relative < 0:
                return []
            cursor += relative + len(exact)
            if exact not in exact_parts:
                exact_parts.append(exact)
        return exact_parts

    def prepare_generated_knowledge(self, items: list[dict], chapters: list[dict]) -> tuple[list[dict], dict]:
        """Validate evidence-backed plot summaries and report per-chapter coverage.

        A plot event keeps the model's short title and summary for human review, but its stable
        identity and chapter placement come only from exact manuscript excerpts.  Downstream
        projections hide an unreviewed summary until the user confirms it.
        """
        chapter_map = {str(chapter["id"]): dict(chapter) for chapter in chapters}
        counts = {cid: 0 for cid in chapter_map}
        normalized: list[dict] = []
        seen_events: set[tuple[str, str]] = set()
        rejected_plot_items: list[dict] = []

        def reject(index: int, reason: str, raw_value, quote: str = "") -> None:
            if len(rejected_plot_items) >= 100:
                return
            value = raw_value if isinstance(raw_value, dict) else {}
            rejected_plot_items.append({
                "model_item": index + 1, "reason": reason,
                "chapter_id": str(value.get("chapter_id") or ""),
                "title": str(value.get("title") or value.get("name") or "")[:160],
                "quote": str(quote or "")[:240],
            })

        for raw_index, raw in enumerate(items or []):
            if not isinstance(raw, dict):
                continue
            raw = dict(raw)
            item_type = str(raw.get("type") or "scene").strip().lower()
            item_type = {
                "剧情": "plot", "剧情事件": "plot", "事件": "plot",
                "plot_event": "plot", "source_event": "plot", "event": "plot",
                "人物": "character", "角色": "character", "关系": "relationship",
                "名词": "term", "世界观": "world", "场景": "scene", "伏笔": "clue",
            }.get(item_type, item_type)
            raw["type"] = item_type
            if item_type != "plot":
                normalized.append(raw)
                continue
            candidates = raw.get("source_quotes") or []
            if not isinstance(candidates, list):
                reject(raw_index, "source_quotes 不是数组", raw)
                continue
            candidate_quotes = [str(value or "").strip()[:800] for value in candidates[:8]
                                if str(value or "").strip()]
            if not candidate_quotes:
                reject(raw_index, "没有提供来源原句", raw)
                continue
            requested = str(raw.get("chapter_id") or "").strip()
            # 一条剧情事件可以用同章内多段原文共同支撑。全部引文必须能落到同一章；
            # 这样概括可以覆盖一段渐进过程，同时仍能追溯每项依据。
            search_chapters = ([chapter_map[requested]] if requested in chapter_map
                               else list(chapter_map.values()))
            located_by_quote: list[dict[str, str]] = []
            for candidate_quote in candidate_quotes:
                located = {chapter["id"]: exact for chapter in search_chapters
                           if (exact := self._locate_source_quote(chapter.get("text") or "", candidate_quote))}
                if not located:
                    reject(raw_index, "引文在所选正文中找不到", raw, candidate_quote)
                    located_by_quote = []
                    break
                located_by_quote.append(located)
            if not located_by_quote:
                continue
            common_ids = set(located_by_quote[0])
            for located in located_by_quote[1:]:
                common_ids.intersection_update(located)
            if len(common_ids) != 1:
                reject(raw_index, "多段引文不能唯一定位到同一章", raw, candidate_quotes[0])
                continue
            chapter_id = next(iter(common_ids))
            chapter = chapter_map[chapter_id]
            quotes = list(dict.fromkeys(located[chapter_id] for located in located_by_quote))
            evidence_key = "\n---\n".join(quotes)
            key = (chapter_id, evidence_key)
            if key in seen_events:
                reject(raw_index, "与本次已经接受的剧情事件重复", raw, quotes[0])
                continue
            seen_events.add(key)
            counts[chapter_id] += 1
            details = self._normalize_knowledge_details(
                "plot", raw.get("details") if isinstance(raw.get("details"), dict) else {},
            )
            offsets = [(chapter.get("text") or "").find(quote) for quote in quotes]
            details["record_kind"] = "evidence_backed_summary"
            details["source_offset"] = min((value for value in offsets if value >= 0), default=0)
            details["source_offsets"] = offsets
            locator_terms = []
            locator_values = []
            for field in ("locator_terms", "characters", "affected_character_titles"):
                values = details.get(field) or []
                if isinstance(values, list):
                    locator_values.extend(values)
            for value in locator_values:
                value = str(value or "").strip()
                if value and value not in locator_terms:
                    locator_terms.append(value[:100])
            if locator_terms:
                details["locator_terms"] = locator_terms[:20]
            if details.get("event_type") == "character_state_change":
                details["interpretation_status"] = "suggested"
            compact = re.sub(r"\s+", " ", quotes[0]).strip()
            title = str(raw.get("title") or raw.get("name") or "").strip()[:300]
            summary = str(raw.get("summary") or raw.get("description") or "").strip()[:4000]
            normalized.append({
                **raw,
                "id": self._source_event_id(chapter_id, evidence_key),
                "type": "plot", "chapter_id": chapter_id,
                "title": title or f"待核对事件：{compact[:28]}{'…' if len(compact) > 28 else ''}",
                "summary": summary or "\n".join(quotes),
                "details": details, "source_quotes": quotes,
                "source_chapter_ids": [chapter_id],
            })
        coverage = {
            "chapters": [{
                "id": cid, "title": chapter_map[cid].get("title") or "未命名章节",
                "position": int(chapter_map[cid].get("position") or 0),
                "events": counts[cid], "required": required_plot_events(chapter_map[cid].get("text") or ""),
            } for cid in chapter_map],
            "rejected_plot_items": rejected_plot_items,
        }
        coverage["missing"] = [entry for entry in coverage["chapters"] if entry["events"] < entry["required"]]
        return normalized, coverage

    def plot_coverage(self, project_id: str, items: list[dict] | None = None) -> dict:
        chapters = self.list_chapters(project_id)
        chapter_map = {chapter["id"]: chapter for chapter in chapters}
        plot_items = [item for item in (items if items is not None else self.list_knowledge(project_id))
                      if item.get("type") == "plot"]
        counts = {chapter["id"]: 0 for chapter in chapters}
        for item in plot_items:
            for cid in item.get("source_chapter_ids") or []:
                chapter = chapter_map.get(cid)
                if chapter and any(quote and quote in chapter.get("text", "") for quote in item.get("source_quotes") or []):
                    counts[cid] += 1
        rows = [{"id": chapter["id"], "title": chapter["title"], "position": chapter["position"],
                 "events": counts[chapter["id"]], "required": required_plot_events(chapter.get("text") or "")}
                for chapter in chapters if (chapter.get("text") or "").strip()]
        return {"total_chapters": len(rows),
                "covered_chapters": sum(row["events"] >= row["required"] for row in rows),
                "missing_chapters": [row for row in rows if row["events"] < row["required"]],
                "chapters": rows}

    @staticmethod
    def _knowledge_title_key(value: str) -> str:
        normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
        return re.sub(r"[\W_]+", "", normalized, flags=re.UNICODE)

    @classmethod
    def _knowledge_identity_keys(cls, title: str, details: dict | None = None) -> set[str]:
        """Return deterministic title/alias keys without using fuzzy similarity."""
        raw_title = str(title or "").strip()
        values = [raw_title]
        base_title = re.sub(r"[（(【\[].*$", "", raw_title).strip()
        if base_title:
            values.append(base_title)
        values.extend(match.strip() for match in re.findall(
            r"[（(【\[]([^）)】\]]+)[）)】\]]", raw_title) if match.strip())
        aliases = (details or {}).get("aliases") or []
        if isinstance(aliases, list):
            values.extend(str(alias).strip() for alias in aliases if isinstance(alias, str) and alias.strip())
        return {key for value in values if (key := cls._knowledge_title_key(value))}

    @staticmethod
    def _normalize_knowledge_details(item_type: str, details: dict) -> dict:
        """Keep character profiles and character-state plot events structurally distinct."""
        result = dict(details or {})
        state_fields = {"event_type", "affected_character_ids", "affected_character_titles",
                        "state_key", "state_before", "state_after", "change_reason", "persistence"}
        if item_type == "character":
            for key in state_fields:
                result.pop(key, None)
            if "stable_profile" in result and not isinstance(result["stable_profile"], dict):
                result.pop("stable_profile", None)
            return result
        if item_type != "plot":
            return result
        event_type = str(result.get("event_type") or "").strip().lower()
        if not event_type:
            return result
        result["event_type"] = event_type if event_type in {"ordinary", "character_state_change"} else "ordinary"
        if result["event_type"] != "character_state_change":
            for key in state_fields - {"event_type"}:
                if not result.get(key):
                    result.pop(key, None)
            return result
        titles = result.get("affected_character_titles") or result.get("characters") or []
        if not isinstance(titles, list):
            titles = []
        result["affected_character_titles"] = list(dict.fromkeys(
            str(value).strip()[:100] for value in titles if isinstance(value, str) and value.strip()
        ))[:20]
        # IDs are resolved from titles when reading. Never persist model-invented database IDs.
        result.pop("affected_character_ids", None)
        for key in ("state_key", "state_before", "state_after", "change_reason"):
            if not isinstance(result.get(key), dict):
                result[key] = str(result.get(key) or "").strip()[:1200]
        persistence = str(result.get("persistence") or "unknown").strip().lower()
        result["persistence"] = persistence if persistence in {"ongoing", "temporary", "permanent", "unknown"} else "unknown"
        return result

    def annotate_same_name_matches(self, project_id: str, items: list[dict],
                                   *, max_order: int | None = None) -> list[dict]:
        """给生成草稿标出已有同类同名卡片；最终保存时仍会重新核对。"""
        clauses, values = ["active=1", "type!='plot'"], []
        if max_order is not None:
            clauses.append("order_start<=?")
            values.append(int(max_order))
        with self._connect(project_id) as conn:
            rows = conn.execute(
                "SELECT id,type,title,summary,review_status,details FROM knowledge_items WHERE " + " AND ".join(clauses),
                values,
            ).fetchall()
        by_id, lookup = {}, {}
        for stored in rows:
            row = dict(stored)
            try:
                details = json.loads(row.pop("details") or "{}")
            except (TypeError, json.JSONDecodeError):
                details = {}
            by_id[row["id"]] = row
            for key in self._knowledge_identity_keys(row["title"], details):
                lookup.setdefault((row["type"], key), set()).add(row["id"])
        result = []
        for raw in items:
            item = dict(raw) if isinstance(raw, dict) else raw
            if isinstance(item, dict):
                item.pop("same_name_match", None)
                item_type = str(item.get("type") or "scene").lower()
                title = item.get("title") or item.get("name") or ""
                keys = self._knowledge_identity_keys(
                    title, item.get("details") if isinstance(item.get("details"), dict) else {})
                exact_key = self._knowledge_title_key(title)
                candidates = set(lookup.get((item_type, exact_key), set())) if exact_key else set()
                if len(candidates) != 1:
                    candidates = set().union(*(lookup.get((item_type, key), set()) for key in keys)) if keys else set()
                if item_type != "plot" and len(candidates) == 1:
                    item["same_name_match"] = by_id[next(iter(candidates))]
            result.append(item)
        return result

    def _merge_same_name_knowledge(self, existing: dict, incoming: dict,
                                   chapters: dict[str, dict], now: str) -> dict:
        """将确定同名的新认识写回原卡片，同时保护用户确认过的正文。"""
        old_details = dict(existing.get("details") or {})
        new_details = dict(incoming.get("details") or {})
        protected = {"knowledge_relations", "related_knowledge_ids", "tags", "tag_periods",
                     "same_name_history", "same_name_updates"}
        clean_new = {key: value for key, value in new_details.items() if key not in protected}
        confirmed = str(existing.get("review_status") or "").startswith("confirmed")
        chapter_titles = [chapters[cid]["title"] for cid in incoming["source_chapter_ids"] if cid in chapters]
        update_record = {
            "id": "ksu_" + uuid4().hex[:20],
            "summary": incoming["summary"], "details": clean_new,
            "source_chapter_ids": incoming["source_chapter_ids"],
            "source_quotes": incoming["source_quotes"],
            "chapter_titles": chapter_titles, "created_at": now,
        }
        if confirmed:
            details = old_details
            updates = list(details.get("same_name_updates") or [])
            fingerprint = json.dumps(update_record, ensure_ascii=False, sort_keys=True)
            if all(json.dumps(value, ensure_ascii=False, sort_keys=True) != fingerprint for value in updates):
                updates.append(update_record)
            details["same_name_updates"] = updates[-20:]
            summary = existing["summary"]
            status = existing["review_status"]
        else:
            history = list(old_details.get("same_name_history") or [])
            history.append({
                "summary": existing["summary"],
                "details": {key: value for key, value in old_details.items() if key not in protected},
                "source_chapter_ids": existing["source_chapter_ids"],
                "source_quotes": existing["source_quotes"], "replaced_at": now,
            })
            details = {**old_details, **clean_new, "same_name_history": history[-20:]}
            if incoming.get("type") == "character":
                details = self._normalize_knowledge_details("character", details)
            summary = incoming["summary"]
            status = "auto"
        sources = list(dict.fromkeys([*existing["source_chapter_ids"], *incoming["source_chapter_ids"]]))
        quotes = list(dict.fromkeys([*existing["source_quotes"], *incoming["source_quotes"]]))
        return {
            **incoming, "id": existing["id"], "title": existing["title"],
            "summary": summary, "details": details,
            "source_chapter_ids": sources, "source_quotes": quotes,
            "order_start": min(int(existing.get("order_start") or 0), int(incoming.get("order_start") or 0)),
            "review_status": status,
            "confidence": max(float(existing.get("confidence") or 0), float(incoming.get("confidence") or 0)),
            "created_at": existing.get("created_at", now), "updated_at": now,
            "same_name_matched": True,
        }

    def list_knowledge(self, project_id: str, item_type: str = "", max_order: int | None = None,
                       *, deleted: bool = False, include_merged_sources: bool = False) -> list[dict]:
        # 2=合并来源：默认隐藏，但较早章节检索仍能读取当时的知识。
        clauses = ["active=-1" if deleted else ("active IN (1,2)" if include_merged_sources or max_order is not None else "active=1")]
        values: list = []
        if item_type:
            clauses.append("type=?")
            values.append(item_type)
        if max_order is not None:
            clauses.append("order_start<=?")
            values.append(int(max_order))
        with self._connect(project_id) as conn:
            rows = conn.execute(
                "SELECT * FROM knowledge_items WHERE " + " AND ".join(clauses) + " ORDER BY order_start,id",
                values,
            ).fetchall()
            merges = [json.loads(row[0]) for row in conn.execute("SELECT data FROM knowledge_workspace_state WHERE kind='merge'").fetchall()] if max_order is not None else []
        result = []
        from .tag_periods import decorate_periods
        tag_chapters = {c["id"]: {k: c[k] for k in ("id", "title", "position")}
                        for c in self.list_chapters(project_id)}
        chapter_positions = {cid: c["position"] for cid, c in tag_chapters.items()}
        for row in rows:
            item = dict(row)
            for key, fallback in (("details", {}), ("source_chapter_ids", []), ("source_quotes", [])):
                try:
                    item[key] = json.loads(item[key] or json.dumps(fallback))
                except json.JSONDecodeError:
                    item[key] = fallback
            item["order_end"] = max((chapter_positions.get(cid, 10**9) for cid in item["source_chapter_ids"]), default=item["order_start"])
            if item["active"] == 2 and not include_merged_sources:
                parent = next((merge for merge in reversed(merges) if merge.get("status") == "applied" and item["id"] in merge.get("item_ids", [])), None)
                if not parent or parent.get("max_order", 0) <= max_order:
                    continue
            if max_order is not None and item["order_end"] > max_order:
                continue
            item["tag_periods"] = decorate_periods(item["details"], tag_chapters, max_order)
            result.append(item)
        return result

    @staticmethod
    def _normalize_knowledge_tags(values, *, limit: int = 20, max_chars: int = 30) -> list[str]:
        if values is None:
            return []
        if not isinstance(values, list):
            raise ValueError("细分标签必须是列表")
        result, seen = [], set()
        for value in values:
            label = str(value or "").strip()
            if not label:
                continue
            if len(label) > max_chars or "\n" in label or "\r" in label:
                raise ValueError(f"每个标签最多{max_chars}字且不能换行")
            key = label.casefold()
            if key in seen:
                continue
            seen.add(key); result.append(label)
        if len(result) > limit:
            raise ValueError(f"每张卡片最多选择{limit}个细分标签")
        return result

    def knowledge_tag_catalog(self, project_id: str, *, conn=None) -> dict:
        """返回按卡片大类隔离的细分标签，以及可复用的关系名称。"""
        fallback = {"id": _TAG_CATALOG_ID, "version": 2,
                    "card_tags": {item_type: [] for item_type in CARD_KNOWLEDGE_TYPES},
                    "relation_labels": [], "relation_layouts": {}}
        with (nullcontext(conn) if conn is not None else self._connect(project_id)) as db:
            row = db.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (_TAG_CATALOG_ID,)).fetchone()
            item_rows = db.execute(
                "SELECT type,details FROM knowledge_items WHERE active=1 AND type!='plot'"
            ).fetchall()
        try:
            stored = json.loads(row["data"]) if row else {}
        except (TypeError, json.JSONDecodeError):
            stored = {}
        result = dict(fallback)
        card_tags = stored.get("card_tags") if isinstance(stored, dict) else {}
        result["card_tags"] = {
            item_type: self._normalize_knowledge_tags(card_tags.get(item_type, []) if isinstance(card_tags, dict) else [], limit=100)
            for item_type in CARD_KNOWLEDGE_TYPES
        }
        result["relation_labels"] = self._normalize_knowledge_tags(
            stored.get("relation_labels", []) if isinstance(stored, dict) else [], limit=200, max_chars=80)
        stored_layouts = stored.get("relation_layouts") if isinstance(stored, dict) else {}
        result["relation_layouts"] = {
            str(label): str(mode) for label, mode in (stored_layouts.items() if isinstance(stored_layouts, dict) else [])
            if str(label).strip() and str(mode) in RELATION_LAYOUT_MODES
        }
        # 第一次启用功能时，把项目里已经存在的细分和人工关系也作为快捷选项展示。
        relation_known = {value.casefold() for value in result["relation_labels"]}
        for item_row in item_rows:
            try:
                details = json.loads(item_row["details"] or "{}")
            except (TypeError, json.JSONDecodeError):
                continue
            item_type = str(item_row["type"])
            if item_type in result["card_tags"]:
                known = {value.casefold() for value in result["card_tags"][item_type]}
                for value in self._normalize_knowledge_tags(details.get("tags", [])):
                    if value.casefold() not in known and len(result["card_tags"][item_type]) < 100:
                        result["card_tags"][item_type].append(value); known.add(value.casefold())
            for edge in details.get("knowledge_relations", []):
                if not isinstance(edge, dict):
                    continue
                for value in self._normalize_knowledge_tags([edge.get("label", "")], max_chars=80):
                    if value.casefold() not in relation_known and len(result["relation_labels"]) < 200:
                        result["relation_labels"].append(value); relation_known.add(value.casefold())
        result["card_tag_usage"] = {
            item_type: {tag: 0 for tag in result["card_tags"][item_type]}
            for item_type in CARD_KNOWLEDGE_TYPES
        }
        for item_row in item_rows:
            item_type = str(item_row["type"])
            if item_type not in result["card_tag_usage"]:
                continue
            try:
                details = json.loads(item_row["details"] or "{}")
            except (TypeError, json.JSONDecodeError):
                continue
            canonical = {tag.casefold(): tag for tag in result["card_tags"][item_type]}
            for value in self._normalize_knowledge_tags(details.get("tags", [])):
                tag = canonical.get(value.casefold())
                if tag:
                    result["card_tag_usage"][item_type][tag] += 1
        return result

    def _extend_knowledge_tag_catalog(self, *, card_type: str = "", card_tags=None,
                                      relation_labels=None, relation_layouts=None, conn) -> dict:
        row = conn.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (_TAG_CATALOG_ID,)).fetchone()
        try:
            stored = json.loads(row["data"]) if row else {}
        except (TypeError, json.JSONDecodeError):
            stored = {}
        catalog = {"id": _TAG_CATALOG_ID, "version": 2,
                   "card_tags": {item_type: [] for item_type in CARD_KNOWLEDGE_TYPES},
                   "relation_labels": [], "relation_layouts": {}}
        if isinstance(stored, dict):
            for item_type in CARD_KNOWLEDGE_TYPES:
                catalog["card_tags"][item_type] = self._normalize_knowledge_tags(
                    (stored.get("card_tags") or {}).get(item_type, []) if isinstance(stored.get("card_tags"), dict) else [], limit=100)
            catalog["relation_labels"] = self._normalize_knowledge_tags(
                stored.get("relation_labels", []), limit=200, max_chars=80)
            stored_layouts = stored.get("relation_layouts")
            if isinstance(stored_layouts, dict):
                catalog["relation_layouts"] = {
                    str(label): str(mode) for label, mode in stored_layouts.items()
                    if str(label).strip() and str(mode) in RELATION_LAYOUT_MODES
                }

        def extend(current: list[str], additions: list[str], limit: int) -> list[str]:
            seen = {value.casefold() for value in current}
            for value in additions:
                if value.casefold() not in seen:
                    current.append(value); seen.add(value.casefold())
            if len(current) > limit:
                raise ValueError("该类别保存的快捷标签过多，请先精简")
            return current

        if card_type:
            if card_type not in CARD_KNOWLEDGE_TYPES:
                raise ValueError("剧情事件索引不使用知识卡片细分标签")
            extend(catalog["card_tags"][card_type], self._normalize_knowledge_tags(card_tags), 100)
        if relation_labels is not None:
            extend(catalog["relation_labels"], self._normalize_knowledge_tags(
                relation_labels, limit=200, max_chars=80), 200)
        if relation_layouts is not None:
            if not isinstance(relation_layouts, dict):
                raise ValueError("关系排布规则格式无效")
            canonical = {label.casefold(): label for label in catalog["relation_labels"]}
            for raw_label, raw_mode in relation_layouts.items():
                labels = self._normalize_knowledge_tags([raw_label], limit=1, max_chars=80)
                if not labels:
                    continue
                mode = str(raw_mode or "").strip()
                if mode not in RELATION_LAYOUT_MODES:
                    raise ValueError("关系排布方式无效")
                label = canonical.get(labels[0].casefold(), labels[0])
                if label.casefold() not in canonical:
                    extend(catalog["relation_labels"], [label], 200)
                    canonical[label.casefold()] = label
                # 同名关系忽略大小写，共用一条排布规则。
                for old_label in list(catalog["relation_layouts"]):
                    if old_label.casefold() == label.casefold() and old_label != label:
                        catalog["relation_layouts"].pop(old_label, None)
                catalog["relation_layouts"][label] = mode
        catalog["updated_at"] = _now()
        conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data",
                     (_TAG_CATALOG_ID, "knowledge_tag_catalog", json.dumps(catalog, ensure_ascii=False)))
        return catalog

    def remember_relation_labels(self, project_id: str, labels: list[str], *, conn=None) -> dict:
        with (nullcontext(conn) if conn is not None else self._connect(project_id)) as db:
            return self._extend_knowledge_tag_catalog(relation_labels=labels, conn=db)

    def remember_relation_layouts(self, project_id: str, layouts: dict[str, str], *, conn=None) -> dict:
        with (nullcontext(conn) if conn is not None else self._connect(project_id)) as db:
            return self._extend_knowledge_tag_catalog(
                relation_labels=list(layouts), relation_layouts=layouts, conn=db)

    def delete_knowledge_tag(self, project_id: str, card_type: str, tag: str) -> dict:
        """Delete one subtype from its catalog, live cards and matching time ranges."""
        if not self.get(project_id):
            raise KeyError(project_id)
        card_type = str(card_type or "").strip().lower()
        if card_type not in CARD_KNOWLEDGE_TYPES:
            raise ValueError("知识卡片大类无效，无法删除细分")
        normalized = self._normalize_knowledge_tags([tag])
        if not normalized:
            raise ValueError("请选择要删除的细分")
        wanted = normalized[0]
        wanted_key = wanted.casefold()
        affected = 0
        removed_from_catalog = False
        now = _now()
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (_TAG_CATALOG_ID,)).fetchone()
            try:
                stored = json.loads(row["data"]) if row else {}
            except (TypeError, json.JSONDecodeError):
                stored = {}
            catalog = {"id": _TAG_CATALOG_ID, "version": 1,
                       "card_tags": {item_type: [] for item_type in CARD_KNOWLEDGE_TYPES},
                       "relation_labels": []}
            if isinstance(stored, dict):
                for item_type in CARD_KNOWLEDGE_TYPES:
                    values = ((stored.get("card_tags") or {}).get(item_type, [])
                              if isinstance(stored.get("card_tags"), dict) else [])
                    catalog["card_tags"][item_type] = self._normalize_knowledge_tags(values, limit=100)
                catalog["relation_labels"] = self._normalize_knowledge_tags(
                    stored.get("relation_labels", []), limit=200, max_chars=80)
            before = catalog["card_tags"][card_type]
            catalog["card_tags"][card_type] = [value for value in before
                                                if value.casefold() != wanted_key]
            removed_from_catalog = len(before) != len(catalog["card_tags"][card_type])

            rows = conn.execute(
                "SELECT id,details FROM knowledge_items WHERE active=1 AND type=?", (card_type,)
            ).fetchall()
            for item_row in rows:
                try:
                    details = json.loads(item_row["details"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(details, dict):
                    continue
                tags = self._normalize_knowledge_tags(details.get("tags", []))
                next_tags = [value for value in tags if value.casefold() != wanted_key]
                periods = details.get("tag_periods", [])
                next_periods = [period for period in periods if not (
                    isinstance(period, dict) and str(period.get("tag") or "").casefold() == wanted_key
                )] if isinstance(periods, list) else []
                if next_tags == tags and next_periods == periods:
                    continue
                details["tags"] = next_tags
                details["tag_periods"] = next_periods
                conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=?",
                             (json.dumps(details, ensure_ascii=False), now, item_row["id"]))
                affected += 1

            catalog["updated_at"] = now
            conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                         "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data",
                         (_TAG_CATALOG_ID, "knowledge_tag_catalog", json.dumps(catalog, ensure_ascii=False)))
            refreshed = self.knowledge_tag_catalog(project_id, conn=conn)
        return {"removed": removed_from_catalog or affected > 0, "tag": wanted,
                "card_type": card_type, "affected_cards": affected,
                "tag_catalog": refreshed}

    def update_knowledge_item(self, project_id: str, item_id: str, **fields) -> dict | None:
        allowed = {"type", "title", "summary", "details", "source_quotes", "source_chapter_ids", "review_status", "tags", "tag_periods"}
        clean = {key: value for key, value in fields.items() if key in allowed}
        requested_source_ids = clean.pop("source_chapter_ids", None) if "source_chapter_ids" in clean else None
        if requested_source_ids is not None:
            if not isinstance(requested_source_ids, list):
                raise ValueError("来源章节必须是列表")
            requested_source_ids = list(dict.fromkeys(
                str(value).strip() for value in requested_source_ids if str(value).strip()
            ))
            if len(requested_source_ids) > 300:
                raise ValueError("一张卡片最多关联300个来源章节")
        if "type" in clean:
            clean["type"] = str(clean["type"]).strip().lower()
            if clean["type"] not in KNOWLEDGE_TYPES:
                raise ValueError("知识卡片类型无效")
        if "title" in clean:
            clean["title"] = str(clean["title"]).strip()[:300]
            if not clean["title"]:
                raise ValueError("知识卡片标题不能为空")
        if "summary" in clean:
            clean["summary"] = str(clean["summary"]).strip()
            if not clean["summary"] or len(clean["summary"]) > 4000:
                raise ValueError("知识卡片内容不能为空或超过4000字")
        if "source_quotes" in clean:
            clean["source_quotes"] = json.dumps(clean["source_quotes"], ensure_ascii=False)
        with self._connect(project_id) as conn:
            current = conn.execute(
                "SELECT type,details,source_chapter_ids,order_start FROM knowledge_items WHERE id=? AND active=1",
                (item_id,),
            ).fetchone()
            if not current:
                return None
            current_type = str(current["type"])
            next_type = clean.get("type", current_type)
            if current_type != "plot" and next_type == "plot":
                raise ValueError("剧情是由原文引文生成的事件索引，普通知识卡片不能转为剧情")
            try:
                current_details = json.loads(current["details"] or "{}")
            except (TypeError, json.JSONDecodeError):
                current_details = {}
            details = clean.get("details", current_details)
            if not isinstance(details, dict):
                raise ValueError("知识卡片结构化详情格式无效")
            details = dict(details)
            details = self._normalize_knowledge_details(next_type, details)
            if requested_source_ids is not None:
                try:
                    current_source_ids = json.loads(current["source_chapter_ids"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    current_source_ids = []
                if not set(current_source_ids).issubset(requested_source_ids):
                    raise ValueError("已有来源章节不能在这里移除；如需纠正来源，请编辑原文依据")
                chapter_rows = conn.execute("SELECT id,position FROM chapters").fetchall()
                chapter_positions = {row["id"]: int(row["position"]) for row in chapter_rows}
                unknown = [chapter_id for chapter_id in requested_source_ids if chapter_id not in chapter_positions]
                if unknown:
                    raise ValueError("所选来源章节不存在，请刷新页面后重试")
                clean["source_chapter_ids"] = json.dumps(requested_source_ids, ensure_ascii=False)
                clean["order_start"] = min(
                    (chapter_positions[chapter_id] for chapter_id in requested_source_ids),
                    default=int(current["order_start"] or 0),
                )
            if "tags" in clean:
                tags = self._normalize_knowledge_tags(clean.pop("tags"))
                details["tags"] = tags
                self._extend_knowledge_tag_catalog(card_type=next_type, card_tags=tags, conn=conn)
            elif next_type != current_type:
                # 细分标签属于原大类；更换大类时不能悄悄沿用。
                details["tags"] = []
            if "tag_periods" in clean:
                from .tag_periods import validate_periods
                tag_chapters = {r["id"]: dict(r) for r in conn.execute("SELECT id,position FROM chapters")}
                details["tag_periods"] = validate_periods(clean.pop("tag_periods"), details.get("tags", []), tag_chapters)
            else:
                # Older clients and edits of other fields must retain user-defined time ranges.
                details["tag_periods"] = [r for r in current_details.get("tag_periods", [])
                                          if r.get("tag") in details.get("tags", [])
                                          and next_type == current_type]
            if "details" in clean or "tags" in fields or "tag_periods" in fields or next_type != current_type:
                clean["details"] = json.dumps(details, ensure_ascii=False)
            clean["updated_at"] = _now()
            conn.execute(
                "UPDATE knowledge_items SET " + ",".join(f"{key}=?" for key in clean) + " WHERE id=? AND active=1",
                (*clean.values(), item_id),
            )
        return next((x for x in self.list_knowledge(project_id) if x["id"] == item_id), None)

    def replace_knowledge_quotes(self, project_id: str, item_id: str,
                                 source_chapter_ids: list[str], source_quotes: list[str]) -> dict | None:
        """Replace one card's citations after exact-text validation, deriving sources from evidence."""
        requested_ids = list(dict.fromkeys(
            str(value).strip() for value in (source_chapter_ids or []) if str(value).strip()
        ))
        candidates = [str(value).strip() for value in (source_quotes or []) if str(value).strip()]
        if not requested_ids:
            raise ValueError("优化后的引文需要至少一个来源章节")
        if not candidates or len(candidates) > 8:
            raise ValueError("优化后的引文需要保留1至8段原文")
        if any(len(value) > 800 for value in candidates):
            raise ValueError("每段来源原文最多800字；请继续缩短或拆成多段")
        with self._connect(project_id) as conn:
            current = conn.execute(
                "SELECT type,source_chapter_ids,order_start FROM knowledge_items WHERE id=? AND active=1",
                (item_id,),
            ).fetchone()
            if not current:
                return None
            if current["type"] == "plot":
                raise ValueError("剧情事件的原文决定事件身份，不能用卡片引文优化替换")
            try:
                old_source_ids = json.loads(current["source_chapter_ids"] or "[]")
            except (TypeError, json.JSONDecodeError):
                old_source_ids = []
            if not set(requested_ids).issubset(old_source_ids):
                raise ValueError("优化引文只能来自这张卡片当前已有的来源章节")
            placeholders = ",".join("?" for _ in requested_ids)
            rows = conn.execute(
                f"SELECT id,text,position FROM chapters WHERE id IN ({placeholders})", requested_ids,
            ).fetchall()
            chapters = {row["id"]: dict(row) for row in rows}
            if len(chapters) != len(requested_ids):
                raise ValueError("部分来源章节已不存在，请刷新卡片后重试")
            exact_quotes, located_ids = [], []
            for candidate in candidates:
                located = None
                for chapter_id in requested_ids:
                    exact_parts = self._locate_source_quote_fragments(
                        chapters[chapter_id].get("text") or "", candidate)
                    if exact_parts:
                        located = (chapter_id, exact_parts)
                        break
                if not located:
                    raise ValueError("有一段优化引文无法在指定来源章节中逐字定位，或删减后的文字顺序与原文不一致；卡片尚未修改")
                for exact in located[1]:
                    if exact not in exact_quotes:
                        exact_quotes.append(exact)
                if len(exact_quotes) > 8:
                    raise ValueError("删减后的引文拆分为超过8段原文，请合并或减少后重试；卡片尚未修改")
                if located[0] not in located_ids:
                    located_ids.append(located[0])
            now = _now()
            order_start = min((chapters[chapter_id]["position"] for chapter_id in located_ids),
                              default=int(current["order_start"] or 0))
            conn.execute(
                "UPDATE knowledge_items SET source_chapter_ids=?,source_quotes=?,order_start=?,updated_at=? "
                "WHERE id=? AND active=1",
                (json.dumps(located_ids, ensure_ascii=False),
                 json.dumps(exact_quotes, ensure_ascii=False), order_start, now, item_id),
            )
        return next((item for item in self.list_knowledge(project_id) if item["id"] == item_id), None)

    def delete_knowledge_item(self, project_id: str, item_id: str) -> bool:
        """移入回收站；删除剧情事件时将来源章节标回待更新。重复删除可安全重试。"""
        if not self.get(project_id):
            return False
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT active,type,source_chapter_ids FROM knowledge_items WHERE id=?", (item_id,)).fetchone()
            if not row or row["active"] not in (1, -1):
                return False
            conn.execute("UPDATE knowledge_items SET active=-1,updated_at=? WHERE id=?", (_now(), item_id))
            if row["type"] == "plot":
                try:
                    source_ids = json.loads(row["source_chapter_ids"] or "[]")
                except json.JSONDecodeError:
                    source_ids = []
                if source_ids:
                    placeholders = ",".join("?" for _ in source_ids)
                    conn.execute(
                        f"UPDATE chapters SET knowledge_status='dirty',updated_at=? WHERE id IN ({placeholders})",
                        (_now(), *source_ids),
                    )
        return True

    def restore_knowledge_item(self, project_id: str, item_id: str) -> dict | None:
        """恢复用户删除的条目；不允许恢复已被后续批次替代的内部历史版本。"""
        if not self.get(project_id):
            return None
        with self._connect(project_id) as conn:
            row = conn.execute("SELECT active FROM knowledge_items WHERE id=?", (item_id,)).fetchone()
            if not row or row["active"] not in (1, -1):
                return None
            conn.execute("UPDATE knowledge_items SET active=1,updated_at=? WHERE id=?", (_now(), item_id))
        return next((x for x in self.list_knowledge(project_id) if x["id"] == item_id), None)

    def context_before(self, project_id: str, chapter_id: str = "") -> tuple[list[dict], list[dict]]:
        chapters = self.list_chapters(project_id)
        current = next((c for c in chapters if c["id"] == chapter_id), None)
        max_order = current["position"] - 1 if current else (max((c["position"] for c in chapters), default=0))
        prior = [c for c in chapters if c["position"] <= max_order]
        return prior, self.list_knowledge(project_id, max_order=max_order)

    def save_vector_index(self, project_id: str, kind: str, records: list[dict],
                          vectors, model: str) -> None:
        if kind not in {"raw", "knowledge"}:
            raise ValueError("索引类型无效")
        directory = self.project_dir(project_id)
        array = np.asarray(vectors, dtype=np.float32)
        if array.ndim != 2 or len(array) != len(records):
            raise ValueError("向量数量与索引记录不一致")
        vec_path = directory / f"{kind}_vectors.npy"
        map_path = directory / f"{kind}_vector_map.json"
        temp_vec = directory / f"{kind}_vectors.tmp.npy"
        temp_map = directory / f"{kind}_vector_map.json.tmp"
        np.save(temp_vec, array)
        temp_map.write_text(json.dumps({
            "model": model, "dimensions": int(array.shape[1]), "records": records,
            "updated_at": _now(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_vec.replace(vec_path)
        temp_map.replace(map_path)

    def load_vector_index(self, project_id: str, kind: str, expected_model: str = ""):
        if kind not in {"raw", "knowledge"}:
            raise ValueError("索引类型无效")
        directory = self.project_dir(project_id)
        vec_path = directory / f"{kind}_vectors.npy"
        map_path = directory / f"{kind}_vector_map.json"
        if not vec_path.exists() or not map_path.exists():
            return None
        mapping = json.loads(map_path.read_text(encoding="utf-8"))
        if expected_model and str(mapping.get("model") or "").casefold() != expected_model.casefold():
            raise ValueError(f"本作知识索引由 {mapping.get('model') or '未知模型'} 建立，请重新更新知识库")
        vectors = np.load(vec_path)
        records = mapping.get("records") or []
        if vectors.ndim != 2 or len(vectors) != len(records):
            raise ValueError("本作知识索引不完整，请重新更新知识库")
        return records, vectors, mapping

    def _refresh_status(self, project_id: str, indexed: bool = False) -> None:
        meta = self.get(project_id)
        if not meta:
            return
        chapter_count = meta.pop("chapter_count", 0)
        dirty_count = meta.pop("dirty_count", 0)
        if not chapter_count:
            meta["status"] = "empty"
        elif not dirty_count:
            meta["status"] = "indexed"
            meta["knowledge_updated_at"] = _now()
        else:
            meta["status"] = "drafting"
        meta["updated_at"] = _now()
        self._write_meta(project_id, meta)
