"""本作知识整理的相关记忆、稳定会话与基础设定建议。"""
from __future__ import annotations

import hashlib
import json
import time
from contextlib import nullcontext
from uuid import uuid4
from .prompts import render_prompt

SETTING_FIELDS = ("concept", "characters", "worldbuilding")
INITIAL_FIELDS = (*SETTING_FIELDS, "style", "current_goal")
SESSION_MAX_CHARS = 60000
SESSION_IDLE_SECONDS = 6 * 60 * 60


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def knowledge_fingerprint(item: dict) -> str:
    return digest({key: item.get(key) for key in (
        "id", "type", "title", "summary", "details", "source_quotes", "source_chapter_ids", "review_status", "active",
    )})


def compact_knowledge(item: dict) -> dict:
    details = {key: value for key, value in (item.get("details") or {}).items()
               if key not in {"source_history", "merged_from", "same_name_history"}}
    if item.get("type") == "plot" and item.get("review_status") != "confirmed":
        # 未核对的AI概括只在前端候审；给后续模型时退回逐字证据。
        details = {key: value for key, value in details.items()
                   if key in {"record_kind", "source_offset", "locator_terms", "event_type",
                              "affected_character_titles", "state_key", "interpretation_status"}}
    unreviewed_plot = item.get("type") == "plot" and item.get("review_status") != "confirmed"
    reliable_summary = "\n".join(item.get("source_quotes") or []) if unreviewed_plot else item.get("summary", "")
    reliable_title = "未核对剧情事件（请依据原文）" if unreviewed_plot else item.get("title", "")
    return {"id": item["id"], "type": item["type"], "title": reliable_title,
            "summary": str(reliable_summary or "")[:2400],
            "details": details, "tag_periods": item.get("tag_periods", []),
            "review_status": item.get("review_status", "auto"),
            "source_quotes": (item.get("source_quotes") or [])[:2],
            "source_chapter_ids": item.get("source_chapter_ids") or [],
            "order_end": item.get("order_end", 0),
            **({"clue_state": item["clue_state"]} if "clue_state" in item else {}),
            **({"linked_clues": item["linked_clues"]} if "linked_clues" in item else {})}


def character_state_snapshot(character: dict, items: list[dict], *, max_states: int = 12,
                             include_manual: bool = True) -> list[dict]:
    """Project the latest continuity-relevant state for one character from plot events."""
    details = character.get("details") or {}
    names = {str(character.get("title") or "").strip().casefold()}
    for alias in details.get("aliases") or []:
        if isinstance(alias, str) and alias.strip():
            names.add(alias.strip().casefold())
    names.discard("")
    latest: dict[str, dict] = {}
    for event in sorted(items, key=lambda item: (
            item.get("order_end", item.get("order_start", 0)),
            int((item.get("details") or {}).get("source_offset") or 0), item.get("id", ""))):
        event_details = event.get("details") or {}
        if (event.get("type") != "plot" or event.get("review_status") != "confirmed"
                or event_details.get("event_type") != "character_state_change"):
            continue
        affected_ids = {str(value) for value in event_details.get("affected_character_ids") or []}
        affected_names = {str(value).strip().casefold() for value in
                          (event_details.get("affected_character_titles") or event_details.get("characters") or [])
                          if str(value).strip()}
        if character.get("id") not in affected_ids and not names.intersection(affected_names):
            continue
        after = event_details.get("state_after")
        if isinstance(after, dict):
            changes = [(str(key).strip(), value) for key, value in after.items()]
        else:
            changes = [(str(event_details.get("state_key") or event.get("title") or "状态").strip(), after)]
        for key, value in changes:
            value = str(value or "").strip()
            if not key or not value:
                continue
            latest[key.casefold()] = {
                "key": key, "value": value,
                "before": str(event_details.get("state_before") or "").strip(),
                "reason": str(event_details.get("change_reason") or "").strip(),
                "persistence": str(event_details.get("persistence") or "unknown").strip(),
                "event_id": event.get("id"), "event_title": event.get("title", ""),
                "order": event.get("order_end", event.get("order_start", 0)),
                "source_chapter_ids": event.get("source_chapter_ids") or [],
            }
    if include_manual:
        overrides = details.get("manual_state_overrides") or []
        for override in overrides if isinstance(overrides, list) else []:
            if not isinstance(override, dict):
                continue
            key = str(override.get("key") or "").strip()
            if not key:
                continue
            normalized_key = key.casefold()
            automatic = latest.get(normalized_key)
            base_order = int(override.get("base_order") or 0)
            base_event_id = str(override.get("base_event_id") or "")
            base_event_order = int(override.get("base_event_order") or 0)
            # 人工修订只覆盖保存时所见的状态；之后新确认的剧情状态仍能自然接管。
            if automatic:
                automatic_order = int(automatic.get("order") or 0)
                if (automatic_order > base_order
                        or (base_event_id and automatic.get("event_id") != base_event_id
                            and automatic_order >= base_event_order)
                        or (not base_event_id and automatic_order >= base_order)):
                    continue
            if override.get("hidden"):
                latest.pop(normalized_key, None)
                continue
            value = str(override.get("value") or "").strip()
            if not value:
                continue
            latest[normalized_key] = {
                "key": key, "value": value,
                "before": str(override.get("before") or "").strip(),
                "reason": str(override.get("reason") or "").strip(),
                "persistence": str(override.get("persistence") or "unknown").strip(),
                "event_id": "", "event_title": "人工调整",
                "order": base_order, "source_chapter_ids": [], "manual": True,
            }
    return sorted(latest.values(), key=lambda state: (state["order"], state["key"]))[-max_states:]


def add_character_state_snapshots(selected: list[dict], universe: list[dict]) -> list[dict]:
    """Decorate compact/full character records without changing persisted card content."""
    result = []
    for item in selected:
        if item.get("type") != "character":
            result.append(item)
            continue
        enriched = dict(item)
        enriched["current_state"] = character_state_snapshot(item, universe)
        result.append(enriched)
    return result


def eligible_knowledge(store, project_id: str, max_order: int | None = None) -> list[dict]:
    chapters = {c["id"]: c for c in store.list_chapters(project_id)}
    return [item for item in store.list_knowledge(project_id, max_order=max_order)
            if item["review_status"] in {"auto", "confirmed"}
            and (((item.get("details") or {}).get("manual_created")
                  and not item.get("source_chapter_ids"))
                 or (item.get("source_chapter_ids")
                     and all(cid in chapters for cid in item["source_chapter_ids"])))]


def select_context(items: list[dict], text: str, semantic_scores: dict | None = None,
                   max_chars: int = 14000) -> tuple[list[dict], dict]:
    """核心设定、近期剧情和相关人物/名词共同召回，不再简单取最后40条。"""
    semantic_scores = semantic_scores or {}
    text = text.casefold()
    # 标题/别名精确命中优先；摘要二元字串用于无向量时的轻量相关匹配。
    grams = {text[i:i + 2] for i in range(len(text) - 1) if text[i:i + 2].strip()}
    def relevance(item):
        details = item.get("details") or {}
        names = [item.get("title", "")]
        for key in ("aliases", "characters"):
            values = details.get(key) or []
            if isinstance(values, list):
                names.extend(str(value) for value in values if isinstance(value, str))
        mentions = sum(1 for name in names if len(name.strip()) >= 2 and name.casefold() in text)
        description = (item.get("title", "") + item.get("summary", "")).casefold()[:1500]
        tokens = {description[i:i + 2] for i in range(len(description) - 1)}
        overlap = len(grams & tokens) / max(1, len(tokens))
        return 8 * mentions + overlap + float(semantic_scores.get(item["id"], 0))
    related = sorted(items, key=lambda item: (relevance(item), item["order_end"]), reverse=True)
    core = sorted((item for item in items if item["type"] in {"character", "relationship", "world", "term"}),
                  key=lambda item: (item["review_status"] == "confirmed", relevance(item), item["order_end"]), reverse=True)
    recent = sorted(items, key=lambda item: item["order_end"], reverse=True)
    # 先保证直接相关的早期信息有名额，避免被大量近期/无关设定挤出。
    candidates = [(item, "related") for item in related[:16]] + [(item, "core") for item in core[:10]] + [(item, "recent") for item in recent[:10]]
    selected, seen, size = [], set(), 0
    categories = {"related": 0, "core": 0, "recent": 0}
    for item, category in candidates:
        if item["id"] in seen:
            continue
        compact = compact_knowledge(item)
        length = len(json.dumps(compact, ensure_ascii=False))
        if size + length > max_chars:
            continue
        selected.append(compact); seen.add(item["id"]); size += length
        categories[category] += 1
    return selected, {"eligible_count": len(items), "selected_count": len(selected), "categories": categories,
                      "retrieval": "关键词 + 向量相关检索" if semantic_scores else "关键词相关检索（无需向量服务）"}


def effective_project(store, project: dict, max_order: int | None = None) -> dict:
    """用户自行输入不受限；从知识提炼的资料仅在来源有效且没有越过章节边界时使用。"""
    result = dict(project)
    provenance = project.get("setting_provenance") or {}
    if not provenance:
        return result
    current = {item["id"]: item for item in eligible_knowledge(store, project["id"])}
    chapters = {c["id"]: c for c in store.list_chapters(project["id"])}
    for field, sources in provenance.items():
        if field not in INITIAL_FIELDS:
            continue
        valid = all(cid in chapters and chapters[cid]["version"] == version for cid, version in sources.get("chapter_versions", {}).items())
        valid = valid and all(item_id in current and knowledge_fingerprint(current[item_id]) == fingerprint
                              for item_id, fingerprint in sources.get("knowledge_fingerprints", {}).items())
        if not valid or (max_order is not None and sources.get("max_order", 0) > max_order):
            result[field] = ""
    return result


class KnowledgeMemory:
    def __init__(self, store, project_id: str):
        self.store, self.project_id = store, project_id

    def latest(self, kind: str) -> dict | None:
        with self.store._connect(self.project_id) as conn:
            row = conn.execute("SELECT data FROM knowledge_workspace_state WHERE kind=? ORDER BY rowid DESC LIMIT 1", (kind,)).fetchone()
        return json.loads(row["data"]) if row else None

    def get(self, document_id: str) -> dict | None:
        with self.store._connect(self.project_id) as conn:
            row = conn.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (document_id,)).fetchone()
        return json.loads(row["data"]) if row else None

    def put(self, kind: str, data: dict, *, conn=None) -> dict:
        with (nullcontext(conn) if conn is not None else self.store._connect(self.project_id)) as conn:
            conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                         "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                         (data["id"], kind, json.dumps(data, ensure_ascii=False)))
        return data

    def reset(self, reason: str) -> None:
        session = self.latest("session")
        if session:
            session["status"] = "closed"; session["reset_reason"] = reason
            self.put("session", session)

    def snapshot_sources(self, items: list[dict], chapters: list[dict] = ()) -> dict:
        chapter_map = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        all_items = {item["id"]: item for item in self.store.list_knowledge(self.project_id, include_merged_sources=True)}
        ids = {cid for item in items for cid in item.get("source_chapter_ids", [])} | {chapter["id"] for chapter in chapters}
        return {"chapter_versions": {cid: chapter_map[cid]["version"] for cid in ids if cid in chapter_map},
                "knowledge_fingerprints": {item["id"]: knowledge_fingerprint(all_items[item["id"]]) for item in items if item["id"] in all_items}}

    def sources_current(self, snapshot: dict) -> bool:
        chapter_map = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        item_map = {item["id"]: item for item in self.store.list_knowledge(self.project_id, include_merged_sources=True)
                    if item["review_status"] in {"auto", "confirmed"}}
        related_ids = set(snapshot.get("related_knowledge_ids") or [])

        def fingerprint_matches(item_id: str, expected: str) -> bool:
            item = item_map.get(item_id)
            if not item:
                return False
            if knowledge_fingerprint(item) == expected:
                return True
            # 合并草稿中的关联卡片只是只读核对依据。它后来被另一组合并归档（active 1→2）
            # 不会改变当时模型看到的事实，不能连带作废仍未处理的其他草稿。
            if item_id in related_ids and item.get("active") == 2:
                return knowledge_fingerprint({**item, "active": 1}) == expected
            return False

        return (all(cid in chapter_map and chapter_map[cid]["version"] == version for cid, version in snapshot.get("chapter_versions", {}).items())
                and all(fingerprint_matches(item_id, fingerprint)
                        for item_id, fingerprint in snapshot.get("knowledge_fingerprints", {}).items()))

    @staticmethod
    def _reading_chapter_data(chapters: list[dict]) -> str:
        return json.dumps([{"id": chapter["id"], "position": chapter.get("position"),
                            "title": chapter["title"], "text": chapter["text"]}
                           for chapter in chapters], ensure_ascii=False)

    def prepare_reading_session(self, chapters: list[dict], identity: str,
                                max_text_chars: int) -> tuple[list[dict], dict]:
        """Persist a stable full-text prefix shared by merge and audit calls."""
        chapter_map = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        requested = [chapter_map[chapter["id"]] for chapter in chapters if chapter.get("id") in chapter_map]
        if not requested:
            raise ValueError("阅读会话没有可用章节")
        previous = self.latest("reading_session")
        reusable = bool(previous and previous.get("status") == "active"
                        and previous.get("identity") == identity and self.sources_current(previous))
        reason = "新建本作阅读会话"

        # 新版连续建库会话已经保存完整章节，可直接继承为阅读前缀，避免再从头发送。
        if not reusable:
            build = self.latest("session")
            if (build and build.get("status") == "active" and build.get("identity") == identity
                    and build.get("read_chapter_ids") and self.sources_current(build)
                    and len(json.dumps(build.get("messages") or [], ensure_ascii=False)) <= max_text_chars + 40000):
                previous = {"id": "kr_" + uuid4().hex[:24], "status": "active", "identity": identity,
                            "messages": list(build["messages"]),
                            "chapter_versions": dict(build.get("chapter_versions") or {}),
                            "knowledge_fingerprints": dict(build.get("knowledge_fingerprints") or {}),
                            "read_chapter_ids": list(build.get("read_chapter_ids") or []),
                            "text_chars": sum(len(chapter_map[cid]["text"]) for cid in build.get("read_chapter_ids", []) if cid in chapter_map),
                            "reuse_count": 0, "created_at": time.time(), "updated_at": time.time()}
                reusable = True
                reason = "复用连续建库会话"

        if reusable:
            read_ids = list(previous.get("read_chapter_ids") or [])
            missing = [chapter for chapter in requested if chapter["id"] not in set(read_ids)]
            combined_chars = int(previous.get("text_chars") or 0) + sum(len(chapter["text"]) for chapter in missing)
            if missing and combined_chars <= max_text_chars:
                previous["messages"].append({"role": "user", "content": render_prompt(
                    "reading_session.chapters", value_1=self._reading_chapter_data(missing))})
                snapshot = self.snapshot_sources([], missing)
                previous["chapter_versions"].update(snapshot["chapter_versions"])
                previous["read_chapter_ids"].extend(chapter["id"] for chapter in missing)
                previous["text_chars"] = combined_chars
                reason = "扩展已有本作阅读会话"
            elif missing:
                reusable = False
                reason = "原阅读会话加上新章节会超过当前上下文预算"
            else:
                reason = "复用已读章节的本作阅读会话"

        if not reusable:
            snapshot = self.snapshot_sources([], requested)
            previous = {"id": "kr_" + uuid4().hex[:24], "status": "active", "identity": identity,
                        "messages": [
                            {"role": "system", "content": render_prompt("reading_session.system")},
                            {"role": "user", "content": render_prompt(
                                "reading_session.chapters", value_1=self._reading_chapter_data(requested))},
                        ], **snapshot, "read_chapter_ids": [chapter["id"] for chapter in requested],
                        "text_chars": sum(len(chapter["text"]) for chapter in requested),
                        "reuse_count": 0, "created_at": time.time(), "updated_at": time.time()}

        previous["reuse_count"] = int(previous.get("reuse_count") or 0) + 1
        previous["updated_at"] = time.time()
        previous["last_reason"] = reason
        self.put("reading_session", previous)
        return list(previous["messages"]), self.public_reading_session(previous)

    def public_reading_session(self, session: dict | None = None) -> dict:
        session = session or self.latest("reading_session")
        if not session:
            return {"status": "none", "read_chapters": 0, "reuse_count": 0}
        return {"id": session.get("id"), "status": session.get("status"),
                "read_chapters": len(session.get("read_chapter_ids") or []),
                "reuse_count": int(session.get("reuse_count") or 0),
                "context_chars": len(json.dumps(session.get("messages") or [], ensure_ascii=False)),
                "text_chars": int(session.get("text_chars") or 0),
                "updated_at": session.get("updated_at"), "last_reason": session.get("last_reason", ""),
                "sources_current": self.sources_current(session)}

    def reset_reading_session(self, reason: str) -> None:
        session = self.latest("reading_session")
        if session:
            session.update(status="closed", last_reason=reason, updated_at=time.time())
            self.put("reading_session", session)

    def prepare(self, project: dict, group: list[dict], evidence: list[dict], identity: str,
                prefix: list[dict], request: dict, keep_context: bool = True) -> tuple[dict, list[dict], dict]:
        previous = self.latest("session")
        current_settings = {field: project.get(field, "") for field in ("name", *INITIAL_FIELDS)}
        settings_hash = digest(current_settings)
        reason = "首次整理"
        reusable = bool(previous and previous.get("status") == "active" and keep_context)
        if not keep_context:
            reason = "本次未启用连续上下文"
        elif previous:
            if previous.get("status") != "active": reason = previous.get("reset_reason") or "已结束旧会话"
            elif previous.get("identity") != identity: reason = "模型配置或提示词方案已改变"; reusable = False
            elif previous.get("settings_hash") != settings_hash: reason = "基础设定或其有效范围已改变"; reusable = False
            elif time.time() - previous.get("updated_at", 0) > SESSION_IDLE_SECONDS: reason = "超过连续整理时间窗口"; reusable = False
            elif min(c["position"] for c in group) <= previous.get("max_order", 0): reason = "回到更早章节，避免后文影响前文"; reusable = False
            elif not self.sources_current(previous): reason = "旧章节或已使用知识被修改/删除"; reusable = False
            elif len(json.dumps(previous["messages"] + [request], ensure_ascii=False)) > SESSION_MAX_CHARS: reason = "历史上下文达到安全长度"; reusable = False
        if reusable:
            session = previous
            reason = "继续上一次整理会话"
        else:
            if previous:
                self.reset(reason)
            session = {"id": "ks_" + uuid4().hex[:24], "status": "active", "identity": identity,
                       "settings_hash": settings_hash, "messages": prefix, "chapter_versions": {}, "knowledge_fingerprints": {},
                       "read_chapter_ids": [],
                       "max_order": 0, "turn_count": 0, "updated_at": time.time(), "reset_reason": reason,
                       "usage_totals": {}, "last_usage": {}}
        messages = session["messages"] + [request]
        context = {"session_id": session["id"], "reused": reusable, "reason": reason,
                   "history_messages": len(session["messages"]), "evidence_ids": [item["id"] for item in evidence]}
        return session, messages, context

    def commit(self, session: dict, messages: list[dict], group: list[dict], evidence: list[dict], usage: dict) -> dict:
        snapshot = self.snapshot_sources(evidence, group)
        for key in ("chapter_versions", "knowledge_fingerprints"):
            session[key].update(snapshot[key])
        session.update(messages=messages, max_order=max(c["position"] for c in group),
                       turn_count=session["turn_count"] + 1, updated_at=time.time(), last_usage=usage)
        read_ids = session.setdefault("read_chapter_ids", [])
        read_ids.extend(chapter["id"] for chapter in group if chapter["id"] not in set(read_ids))
        for key, value in usage.items():
            if isinstance(value, int) and value >= 0:
                session["usage_totals"][key] = session["usage_totals"].get(key, 0) + value
        return self.put("session", session)

    def feedback(self, session_id: str, items: list[dict], accepted: bool) -> None:
        session = self.latest("session")
        if not session or session["id"] != session_id or session["status"] != "active":
            return
        if not accepted:
            self.reset("用户拒绝上一批理解，重新读取有效知识")
            return
        session["messages"].append({"role": "user", "content": render_prompt('feedback.user', value_1=json.dumps([compact_knowledge(item) for item in items], ensure_ascii=False))})
        snapshot = self.snapshot_sources(items)
        for key in ("chapter_versions", "knowledge_fingerprints"):
            session[key].update(snapshot[key])
        session["updated_at"] = time.time()
        self.put("session", session)

    def public_session(self) -> dict:
        session = self.latest("session")
        if not session: return {"status": "none", "turn_count": 0}
        return {key: session.get(key) for key in ("id", "status", "turn_count", "updated_at", "reset_reason", "last_usage", "usage_totals")} | {
            "context_chars": len(json.dumps(session["messages"], ensure_ascii=False)),
            "sources_current": self.sources_current(session)}

    def save_suggestion(self, parsed: dict, project: dict, evidence: list[dict]) -> dict:
        allowed = {item["id"]: item for item in evidence}
        fields = {}
        if not isinstance(parsed, dict) or not isinstance(parsed.get("fields"), dict):
            raise ValueError("模型未返回有效的设定建议")
        for key in SETTING_FIELDS:
            raw = (parsed.get("fields") or {}).get(key) or {}
            if not isinstance(raw, dict): continue
            text = str(raw.get("text") or "").strip()[:20000]
            ids = list(dict.fromkeys(value for value in (raw.get("knowledge_ids") or []) if isinstance(value, str)))
            if text and ids and all(value in allowed for value in ids):
                fields[key] = {"text": text, "knowledge_ids": ids}
        if not fields:
            raise ValueError("未生成带有效知识来源的设定建议；请先积累更多知识后重试")
        used = [allowed[value] for value in dict.fromkeys(value for field in fields.values() for value in field["knowledge_ids"])]
        proposal = {"id": "sp_" + uuid4().hex[:24], "status": "pending", "fields": fields,
                    "baseline": {key: project.get(key, "") for key in SETTING_FIELDS},
                    "evidence": used, "created_at": time.time(), **self.snapshot_sources(used)}
        return self.put("suggestion", proposal)

    def apply_suggestion(self, proposal_id: str, selected_fields: list[str], edited: dict, overwrite_fields: list[str]) -> dict:
        proposal = self.get(proposal_id)
        if not proposal or proposal.get("status") != "pending" or "fields" not in proposal:
            raise ValueError("该设定建议不存在或已处理")
        if not self.sources_current(proposal):
            raise ValueError("建议的来源知识或正文已改变，请重新生成后确认")
        if not selected_fields or any(key not in proposal["fields"] for key in selected_fields):
            raise ValueError("请选择有来源依据的设定字段")
        project = self.store.get(self.project_id)
        updates, provenance = {}, dict(project.get("setting_provenance") or {})
        by_id = {item["id"]: item for item in proposal["evidence"]}
        for key in set(selected_fields):
            if project.get(key, "") != proposal["baseline"].get(key, ""):
                raise ValueError("生成建议后用户设定已被修改，请重新生成，避免覆盖新内容")
            if project.get(key) and key not in overwrite_fields:
                raise ValueError("已有设定不会自动覆盖，请明确勾选允许替换的字段")
            value = edited.get(key, proposal["fields"][key]["text"])
            if not isinstance(value, str) or not value.strip() or len(value) > 20000:
                raise ValueError("设定内容不能为空或超过20000字")
            updates[key] = value.strip()
            sources = [by_id[item_id] for item_id in proposal["fields"][key]["knowledge_ids"]]
            provenance[key] = {"kind": "knowledge_confirmed", "proposal_id": proposal_id,
                               "max_order": max(item["order_end"] for item in sources), **self.snapshot_sources(sources)}
        updated = self.store.update(self.project_id, **updates)
        updated["setting_provenance"] = provenance
        self.store._write_meta(self.project_id, {key: value for key, value in updated.items() if key not in {"chapter_count", "dirty_count"}})
        proposal.update(status="applied", applied_fields=selected_fields)
        self.put("suggestion", proposal)
        self.reset("已确认新的基础设定")
        return self.store.get(self.project_id)
