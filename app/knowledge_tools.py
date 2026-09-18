"""知识合并与全文查漏：建议先保存，确认后事务写入，不隐式替换其他知识。"""
from __future__ import annotations

import json
import hashlib
import re
import time
from uuid import uuid4

from .knowledge_memory import KnowledgeMemory, compact_knowledge, digest, eligible_knowledge, knowledge_fingerprint, select_context
from .projects import KNOWLEDGE_TYPES, group_complete_chapters


class KnowledgeTools(KnowledgeMemory):
    _QUOTE_EQUIVALENTS = str.maketrans({
        "“": '"', "”": '"', "„": '"', "‟": '"', "＂": '"',
        "‘": "'", "’": "'", "‚": "'", "‛": "'", "＇": "'",
    })

    @classmethod
    def _locate_source_quote(cls, quote: str, text: str) -> str:
        """Locate a model quote safely and return the exact substring from the novel."""
        quote = str(quote or "").strip()
        if not quote:
            return ""
        if quote in text:
            return quote

        variants = [quote]
        # Models sometimes wrap an otherwise exact excerpt in quotation marks or ellipses.
        trimmed = quote.strip("\"'“”‘’《》")
        trimmed = re.sub(r"^(?:\.{3,}|…+)", "", trimmed)
        trimmed = re.sub(r"(?:\.{3,}|…+)$", "", trimmed).strip()
        if trimmed and trimmed != quote:
            variants.append(trimmed)

        normalized_text, positions = [], []
        for index, char in enumerate(text):
            if char.isspace():
                continue
            normalized_text.append(char.translate(cls._QUOTE_EQUIVALENTS))
            positions.append(index)
        haystack = "".join(normalized_text)
        for candidate in variants:
            needle = "".join(char.translate(cls._QUOTE_EQUIVALENTS)
                             for char in candidate if not char.isspace())
            # Short evidence must remain exact; relaxed matching is only safe for a substantial excerpt.
            if len(needle) < 8:
                continue
            offset = haystack.find(needle)
            if offset >= 0:
                return text[positions[offset]:positions[offset + len(needle) - 1] + 1]
        return ""

    @staticmethod
    def _relation_id(source_id: str, target_id: str) -> str:
        return "kr_" + hashlib.sha256(f"{source_id}|{target_id}".encode("utf-8")).hexdigest()[:24]

    def _validate_relation_period(self, valid_from_chapter_id: str = "",
                                  invalid_from_chapter_id: str = "") -> tuple[str, str]:
        valid_from = str(valid_from_chapter_id or "").strip()
        invalid_from = str(invalid_from_chapter_id or "").strip()
        chapters = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        if valid_from and valid_from not in chapters:
            raise ValueError("关系的建立章节不存在，请刷新章节目录")
        if invalid_from and invalid_from not in chapters:
            raise ValueError("关系的失效章节不存在，请刷新章节目录")
        if valid_from and invalid_from and int(chapters[invalid_from]["position"]) <= int(chapters[valid_from]["position"]):
            raise ValueError("关系的失效章节必须晚于建立章节")
        return valid_from, invalid_from

    def _decorate_relation_period(self, edge: dict, chapters: dict[str, dict] | None = None) -> dict:
        result = dict(edge)
        chapters = chapters or {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        valid_from = str(edge.get("valid_from_chapter_id") or "")
        invalid_from = str(edge.get("invalid_from_chapter_id") or "")
        result["valid_from_chapter_id"] = valid_from
        result["invalid_from_chapter_id"] = invalid_from
        result["valid_from_chapter"] = ({"id": valid_from, "title": chapters[valid_from]["title"],
                                           "position": chapters[valid_from]["position"]}
                                          if valid_from in chapters else None)
        result["invalid_from_chapter"] = ({"id": invalid_from, "title": chapters[invalid_from]["title"],
                                             "position": chapters[invalid_from]["position"]}
                                            if invalid_from in chapters else None)
        result["temporal_status"] = ("ended" if invalid_from in chapters else
                                     "unknown" if invalid_from else "active")
        return result

    @staticmethod
    def relation_period_description(relation: dict) -> str:
        """Return a compact, model-readable chapter range for an explicit relation."""
        start = (relation.get("valid_from_chapter") or {}).get("title")
        end = (relation.get("invalid_from_chapter") or {}).get("title")
        if start and end:
            return f"{start}起、{end}起失效"
        if end:
            return f"{end}起失效"
        if start:
            return f"{start}起持续有效"
        if relation.get("invalid_from_chapter_id"):
            return "失效章节已不存在，时间范围待修正"
        return "长期有效"

    def relation_edges(self, items: list[dict]) -> list[dict]:
        # 剧情是按章节排列的事件索引，不是可互相连接、合并的实体卡片。
        items = [item for item in items if item.get("type") != "plot"]
        available = {item["id"]: item for item in items}
        chapters = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        result = []
        seen = set()
        for item in items:
            details = item.get("details") or {}
            for edge in details.get("knowledge_relations", []):
                target = str(edge.get("target_id") or "") if isinstance(edge, dict) else ""
                label = str(edge.get("label") or "相关").strip()[:80] if isinstance(edge, dict) else "相关"
                key = frozenset((item["id"], target))
                if target not in available or target == item["id"] or key in seen: continue
                seen.add(key)
                relation_id = str(edge.get("id") or "") if isinstance(edge, dict) else ""
                result.append(self._decorate_relation_period({
                    "id": relation_id or self._relation_id(item["id"], target),
                    "source_id": item["id"], "target_id": target, "label": label,
                    "valid_from_chapter_id": str(edge.get("valid_from_chapter_id") or "") if isinstance(edge, dict) else "",
                    "invalid_from_chapter_id": str(edge.get("invalid_from_chapter_id") or "") if isinstance(edge, dict) else "",
                }, chapters))
            for target in details.get("related_knowledge_ids", []):
                key = frozenset((item["id"], str(target)))
                if target not in available or target == item["id"] or key in seen: continue
                seen.add(key)
                result.append(self._decorate_relation_period({
                    "id": self._relation_id(item["id"], str(target)),
                    "source_id": item["id"], "target_id": str(target), "label": "相关",
                    "valid_from_chapter_id": "", "invalid_from_chapter_id": "",
                }, chapters))
        return result

    @staticmethod
    def _relation_snapshot(edges: list[dict]) -> list[dict]:
        return sorted(({"id": str(edge["id"]), "source_id": str(edge["source_id"]),
                        "target_id": str(edge["target_id"]), "label": str(edge["label"]),
                        "valid_from_chapter_id": str(edge.get("valid_from_chapter_id") or ""),
                        "invalid_from_chapter_id": str(edge.get("invalid_from_chapter_id") or "")}
                       for edge in edges),
                      key=lambda edge: (edge["source_id"], edge["target_id"], edge["id"]))

    @staticmethod
    def _combined_relation_label(first: str, second: str, *, reverse: bool = False) -> str:
        first, second = str(first or "相关").strip(), str(second or "相关").strip()
        addition = f"反向：{second}" if reverse else second
        if addition == first or not addition:
            return first[:80]
        combined = f"{first}；{addition}"
        return combined if len(combined) <= 80 else combined[:79].rstrip("；") + "…"

    def _transfer_merge_relations(self, edges: list[dict], source_ids: set[str], merged_id: str) -> list[dict]:
        """Move every external relation from merged sources onto the replacement card."""
        transferred: list[dict] = []
        by_pair: dict[frozenset[str], dict] = {}
        for edge in edges:
            source = merged_id if edge["source_id"] in source_ids else edge["source_id"]
            target = merged_id if edge["target_id"] in source_ids else edge["target_id"]
            if source == target:
                # Relations wholly inside the merged group have become part of one card.
                continue
            pair = frozenset((source, target))
            current = by_pair.get(pair)
            if current is None:
                current = {"id": str(edge["id"]), "source_id": source, "target_id": target,
                           "label": str(edge.get("label") or "相关").strip()[:80],
                           "valid_from_chapter_id": str(edge.get("valid_from_chapter_id") or ""),
                           "invalid_from_chapter_id": str(edge.get("invalid_from_chapter_id") or "")}
                by_pair[pair] = current
                transferred.append(current)
                continue
            reverse = current["source_id"] == target and current["target_id"] == source
            current["label"] = self._combined_relation_label(
                current["label"], str(edge.get("label") or "相关"), reverse=reverse)
            # A merged card inherits the broadest safe chapter-level range. An empty
            # boundary means the relation extends beyond the known book boundary.
            positions = {chapter["id"]: int(chapter["position"])
                         for chapter in self.store.list_chapters(self.project_id)}
            starts = [value for value in (current.get("valid_from_chapter_id"),
                                          edge.get("valid_from_chapter_id")) if value]
            ends = [value for value in (current.get("invalid_from_chapter_id"),
                                        edge.get("invalid_from_chapter_id")) if value]
            current["valid_from_chapter_id"] = ("" if len(starts) < 2 else min(starts, key=lambda value: positions.get(value, 10**9)))
            current["invalid_from_chapter_id"] = ("" if len(ends) < 2 else max(ends, key=lambda value: positions.get(value, -1)))
        merged_degree = sum(merged_id in (edge["source_id"], edge["target_id"]) for edge in transferred)
        if merged_degree > 50:
            raise ValueError(f"这些卡片合并后会产生 {merged_degree} 条关联，超过单张卡片50条的上限；请先整理关联")
        return self._relation_snapshot(transferred)

    @staticmethod
    def _write_relation_edges(conn, items: dict[str, dict], edges: list[dict],
                              touch_ids: set[str] | None = None) -> None:
        outgoing = {item_id: [] for item_id in items}
        for edge in edges:
            source, target = edge["source_id"], edge["target_id"]
            if source not in items or target not in items or source == target:
                raise ValueError("合并关联中包含已失效卡片，请刷新后重试")
            outgoing[source].append({"id": edge["id"], "target_id": target, "label": edge["label"],
                                     "valid_from_chapter_id": str(edge.get("valid_from_chapter_id") or ""),
                                     "invalid_from_chapter_id": str(edge.get("invalid_from_chapter_id") or "")})
        now = time.time()
        for item_id, item in items.items():
            if touch_ids is not None and item_id not in touch_ids:
                continue
            original_details = dict(item.get("details") or {})
            details = dict(original_details)
            if outgoing[item_id]:
                details["knowledge_relations"] = outgoing[item_id]
            else:
                details.pop("knowledge_relations", None)
            details.pop("related_knowledge_ids", None)
            item["details"] = details
            if details != original_details:
                conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=?",
                             (json.dumps(details, ensure_ascii=False), now, item_id))

    def relation_map(self, items: list[dict]) -> dict[str, list[dict]]:
        items = [item for item in items if item.get("type") != "plot"]
        available = {item["id"]: item for item in items}
        links = {item_id: [] for item_id in available}
        for edge in self.relation_edges(items):
            source, target = edge["source_id"], edge["target_id"]
            links[source].append({"id": target, "relation_id": edge["id"], "source_id": source,
                                  "target_id": target, "label": edge["label"], "direction": "out",
                                  "valid_from_chapter_id": edge.get("valid_from_chapter_id", ""),
                                  "invalid_from_chapter_id": edge.get("invalid_from_chapter_id", ""),
                                  "valid_from_chapter": edge.get("valid_from_chapter"),
                                  "invalid_from_chapter": edge.get("invalid_from_chapter"),
                                  "temporal_status": edge.get("temporal_status", "active")})
            links[target].append({"id": source, "relation_id": edge["id"], "source_id": source,
                                  "target_id": target, "label": edge["label"], "direction": "in",
                                  "valid_from_chapter_id": edge.get("valid_from_chapter_id", ""),
                                  "invalid_from_chapter_id": edge.get("invalid_from_chapter_id", ""),
                                  "valid_from_chapter": edge.get("valid_from_chapter"),
                                  "invalid_from_chapter": edge.get("invalid_from_chapter"),
                                  "temporal_status": edge.get("temporal_status", "active")})
        return {item_id: [dict(link, type=available[link["id"]]["type"], title=available[link["id"]]["title"],
                                    summary=available[link["id"]]["summary"][:300])
                          for link in sorted(values, key=lambda value: (value["label"], available[value["id"]]["title"]))]
                for item_id, values in links.items()}

    def set_relations(self, item_id: str, relations: list[dict]) -> dict:
        if len(relations) > 50: raise ValueError("每张卡片最多关联50张其他卡片")
        items = {item["id"]: item for item in eligible_knowledge(self.store, self.project_id)
                 if item.get("type") != "plot"}
        if item_id not in items:
            raise ValueError("卡片已删除、待复核或不属于本小说，请刷新后重试")
        clean, used = [], set()
        existing_edges = self.relation_edges(list(items.values()))
        existing_by_pair = {frozenset((edge["source_id"], edge["target_id"])): edge
                            for edge in existing_edges}
        for relation in relations:
            if not isinstance(relation, dict): raise ValueError("关联格式无效")
            other_id, direction = str(relation.get("related_id") or ""), str(relation.get("direction") or "out")
            label = str(relation.get("label") or "").strip()
            if other_id == item_id: raise ValueError("卡片不能关联自己")
            if other_id not in items: raise ValueError("关联卡片已删除、待复核或不属于本小说")
            if other_id in used: raise ValueError("同两张卡片之间请合并为一个关系名称")
            if direction not in {"out", "in"}: raise ValueError("关系方向无效")
            if not label or len(label) > 80 or "\n" in label or "\r" in label:
                raise ValueError("关系名称必填，最多80字且不能换行")
            previous = existing_by_pair.get(frozenset((item_id, other_id))) or {}
            valid_from, invalid_from = self._validate_relation_period(
                relation.get("valid_from_chapter_id", previous.get("valid_from_chapter_id", "")),
                relation.get("invalid_from_chapter_id", previous.get("invalid_from_chapter_id", "")),
            )
            used.add(other_id); clean.append({"related_id": other_id, "direction": direction, "label": label,
                                               "layout_mode": str(relation.get("layout_mode") or "").strip(),
                                               "valid_from_chapter_id": valid_from,
                                               "invalid_from_chapter_id": invalid_from,
                                               "id": previous.get("id") or "kr_" + uuid4().hex[:24]})
        with self.store._connect(self.project_id) as conn:
            outgoing = {}
            for current_id, current in items.items():
                details = dict(current.get("details") or {})
                edges = [edge for edge in details.get("knowledge_relations", []) if isinstance(edge, dict)
                         and edge.get("target_id") in items and current_id != item_id and edge.get("target_id") != item_id]
                legacy = [value for value in details.get("related_knowledge_ids", [])
                          if isinstance(value, str) and value in items and value != item_id] if current_id != item_id else []
                outgoing[current_id] = (details, edges, legacy)
            for relation in clean:
                source = item_id if relation["direction"] == "out" else relation["related_id"]
                target = relation["related_id"] if relation["direction"] == "out" else item_id
                outgoing[source][1].append({"id": relation["id"], "target_id": target, "label": relation["label"],
                                            "valid_from_chapter_id": relation["valid_from_chapter_id"],
                                            "invalid_from_chapter_id": relation["invalid_from_chapter_id"]})
            for current_id, (details, edges, legacy) in outgoing.items():
                old_edges, old_legacy = details.get("knowledge_relations", []), details.get("related_knowledge_ids", [])
                details["knowledge_relations"], details["related_knowledge_ids"] = edges, legacy
                if edges != old_edges or legacy != old_legacy:
                    conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=? AND active=1",
                                 (json.dumps(details, ensure_ascii=False), time.time(), current_id))
            self.store.remember_relation_labels(
                self.project_id,
                [edge.get("label", "") for edge in existing_edges] + [relation["label"] for relation in clean],
                conn=conn,
            )
            layouts = {relation["label"]: relation["layout_mode"] for relation in clean
                       if relation.get("layout_mode")}
            if layouts:
                self.store.remember_relation_layouts(self.project_id, layouts, conn=conn)
        self.reset("知识卡片关联已修改，下次读取新的关联依据")
        return next(item for item in self.store.list_knowledge(self.project_id) if item["id"] == item_id)
    def related_context(self, items: list[dict], *, max_items: int = 12, max_chars: int = 12000) -> list[dict]:
        """Find other cards explicitly mentioned by the merge inputs; they are evidence, not merge inputs."""
        selected_ids = {item["id"] for item in items}
        selected_text = "\n".join(item.get("title", "") + "\n" + item.get("summary", "") + "\n" +
                                   json.dumps(item.get("details") or {}, ensure_ascii=False) for item in items).casefold()
        stop_grams = {"人物", "角色", "已经", "目前", "可以", "可能", "没有", "一个", "这个", "某种", "相关", "知识", "信息", "状态"}
        selected_grams = {selected_text[i:i + 2] for i in range(len(selected_text) - 1)
                          if re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9]{2}", selected_text[i:i + 2])
                          and selected_text[i:i + 2] not in stop_grams}
        generic = {"主角", "人物", "角色", "同伴", "对手", "组织", "能力", "装置", "未知", "未确认"}

        def names(item: dict) -> set[str]:
            values = [item.get("title", "")]
            details = item.get("details") or {}
            for key in ("aliases", "characters", "affected_character_titles"):
                raw = details.get(key) or []
                if isinstance(raw, list): values.extend(value for value in raw if isinstance(value, str))
            return {value.strip().casefold() for value in values if 2 <= len(value.strip()) <= 100 and value.strip().casefold() not in generic}

        selected_names = set().union(*(names(item) for item in items))
        all_items = eligible_knowledge(self.store, self.project_id)
        relations = self.relation_map([item for item in all_items if item.get("type") != "plot"])
        manual = {link["id"]: link for item_id in selected_ids for link in relations.get(item_id, [])}
        explicit = set(manual)
        selected_chapters = {cid for item in items for cid in item.get("source_chapter_ids", [])}
        ranked = []
        for candidate in all_items:
            if candidate["id"] in selected_ids: continue
            description = (candidate.get("title", "") + "\n" + candidate.get("summary", "") + "\n" +
                           json.dumps(candidate.get("details") or {}, ensure_ascii=False)).casefold()
            candidate_names = names(candidate)
            matched = sorted({name for name in candidate_names if name in selected_text} |
                             {name for name in selected_names if name in description}, key=len, reverse=True)
            candidate_grams = {description[i:i + 2] for i in range(len(description) - 1)
                               if re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9]{2}", description[i:i + 2])}
            shared_grams = sorted(selected_grams.intersection(candidate_grams) - stop_grams)
            score = (100 if candidate["id"] in explicit else 0) + sum(min(len(name), 12) for name in matched) + min(len(shared_grams), 5)
            if not score: continue
            if selected_chapters.intersection(candidate.get("source_chapter_ids", [])): score += 1
            related = compact_knowledge(candidate)
            concepts = matched[:5] or shared_grams[:5]
            relation = manual.get(candidate["id"])
            related["relation_reason"] = (("已手动关联：" + relation["label"] +
                                           ("" if not relation.get("valid_from_chapter_id") and
                                            not relation.get("invalid_from_chapter_id") else
                                            f"（{self.relation_period_description(relation)}）"))
                                          if relation else "共同提及：" + "、".join(concepts))
            ranked.append((score, candidate["review_status"] == "confirmed", candidate["order_end"], related))
        ranked.sort(key=lambda row: row[:3], reverse=True)
        result, size = [], 0
        for _, _, _, item in ranked:
            length = len(json.dumps(item, ensure_ascii=False))
            if len(result) >= max_items or size + length > max_chars: continue
            result.append(item); size += length
        return result

    def pending_merges(self) -> list[dict]:
        with self.store._connect(self.project_id) as conn:
            records = [json.loads(row[0]) for row in conn.execute(
                "SELECT data FROM knowledge_workspace_state WHERE kind='merge' ORDER BY rowid DESC")]
        return [record for record in records if record.get("status") == "pending"]

    @staticmethod
    def auto_merge_card(item: dict) -> dict:
        aliases = (item.get("details") or {}).get("aliases")
        return {"id": item["id"], "type": item["type"], "title": item["title"],
                "summary": item["summary"][:1200], "order_end": item["order_end"],
                "aliases": [a[:100] for a in aliases[:20] if isinstance(a, str)] if isinstance(aliases, list) else [],
                "review_status": item["review_status"]}

    def auto_merge_batches(self) -> list[list[dict]]:
        reserved = {i for p in self.pending_merges() for i in p["item_ids"]}
        items = [k for k in eligible_knowledge(self.store, self.project_id)
                 if k["id"] not in reserved and k.get("type") != "plot"]
        # Titles and aliases cluster related entities before bounded, overlapping AI scans.
        # Only compact card metadata is sent, never the complete novel.
        def sort_key(item):
            aliases = (item.get("details") or {}).get("aliases") or []
            aliases = [a for a in aliases if isinstance(a, str)] if isinstance(aliases, list) else []
            return (item["type"], re.sub(r"\W+", "", min([item["title"], *aliases])).casefold(), item["order_end"])
        items.sort(key=sort_key)
        batches, current, size = [], [], 0
        for item in items:
            compact = self.auto_merge_card(item)
            cost = len(json.dumps(compact, ensure_ascii=False))
            if current and (len(current) >= 40 or size + cost > 24000):
                if len(current) >= 2: batches.append(current)
                current = current[-6:]
                size = len(json.dumps(current, ensure_ascii=False))
                while current and size + cost > 24000:
                    current = current[1:]
                    size = len(json.dumps(current, ensure_ascii=False))
            current.append(compact); size += cost
        if len(current) >= 2: batches.append(current)
        return batches

    @staticmethod
    def validate_auto_groups(parsed: dict, batch: list[dict], reserved: set[str],
                             discarded: list[str] | None = None) -> list[list[str]]:
        discarded = discarded if discarded is not None else []
        groups = parsed.get("groups") if isinstance(parsed, dict) else None
        if not isinstance(groups, list):
            raise ValueError("模型未返回有效的自动合并分组")
        if len(groups) > 5:
            discarded.append(f"模型返回 {len(groups)} 组，按约定只检查前5组")
            groups = groups[:5]
        allowed = {item["id"] for item in batch}
        used, result = set(), []
        for index, group in enumerate(groups, 1):
            ids = group.get("item_ids") if isinstance(group, dict) else None
            if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or not 2 <= len(ids) <= 12:
                discarded.append(f"第{index}组格式无效或卡片数不在2～12张之间")
                continue
            if len(set(ids)) != len(ids):
                discarded.append(f"第{index}组在组内重复使用卡片，已跳过")
                continue
            if set(ids) - allowed:
                discarded.append(f"第{index}组包含当前批次不存在的卡片ID，已跳过")
                continue
            if used.intersection(ids):
                discarded.append(f"第{index}组与本批前面的分组重复使用卡片，已跳过")
                continue
            if reserved.intersection(ids):
                discarded.append(f"第{index}组使用了已生成草稿的卡片，已跳过")
                continue
            used.update(ids)
            result.append(ids)
        return result

    def clear_audits(self) -> None:
        # 归档所有旧报告，避免清空最新一份后更早的报告再次出现。
        with self.store._connect(self.project_id) as conn:
            rows = conn.execute("SELECT id,data FROM knowledge_workspace_state WHERE kind='audit'").fetchall()
            for row in rows:
                data = json.loads(row["data"])
                data.update(previous_status=data.get("status"), status="cleared")
                conn.execute("UPDATE knowledge_workspace_state SET kind='audit_archive',data=? WHERE id=?",
                             (json.dumps(data, ensure_ascii=False), row["id"]))

    def merge_history(self) -> list[dict]:
        with self.store._connect(self.project_id) as conn:
            records = [json.loads(row[0]) for row in conn.execute("SELECT data FROM knowledge_workspace_state WHERE kind='merge' ORDER BY rowid DESC")]
        return [{"id": record["id"], "title": record["item"]["title"], "merged_id": record["merged_id"]}
                for record in records if record.get("status") == "applied"]

    def merge_inputs(self, item_ids: list[str]) -> list[dict]:
        ids = list(dict.fromkeys(item_ids))
        if not 2 <= len(ids) <= 12:
            raise ValueError("每次请选择2～12张相关知识卡片合并")
        available = {item["id"]: item for item in eligible_knowledge(self.store, self.project_id)}
        if any(item_id not in available for item_id in ids):
            raise ValueError("所选卡片已删除、待复核或不属于本小说，请刷新后重选")
        items = [available[item_id] for item_id in ids]
        if any(item.get("type") == "plot" for item in items):
            raise ValueError("剧情属于章节事件索引，不参与知识卡片合并")
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        ordered_chapters = sorted(chapters.values(), key=lambda chapter: chapter.get("position", 0))
        resolved_items, repairs = [], []
        for item in items:
            quotes = [str(value).strip() for value in (item.get("source_quotes") or [])
                      if isinstance(value, str) and value.strip()]
            linked_ids = [cid for cid in item.get("source_chapter_ids", []) if cid in chapters]
            resolved_quotes = []
            for quote in quotes:
                candidates = [chapters[cid] for cid in linked_ids]
                candidates.extend(chapter for chapter in ordered_chapters if chapter["id"] not in linked_ids)
                located = next(((chapter["id"], exact) for chapter in candidates
                                if (exact := self._locate_source_quote(quote, chapter["text"]))), None)
                if not located:
                    # 卡片已经通过建库/人工确认保存。合并只消费现有知识，不应因为
                    # 旧数据的章节映射、空白或标点差异再次否定其出处。找不到时保留
                    # 原记录；能在全文找到时才静默纠正章节和逐字引文。
                    if quote not in resolved_quotes:
                        resolved_quotes.append(quote)
                    continue
                chapter_id, exact_quote = located
                if chapter_id not in linked_ids:
                    linked_ids.append(chapter_id)
                if exact_quote not in resolved_quotes:
                    resolved_quotes.append(exact_quote)
            resolved = dict(item)
            resolved["source_chapter_ids"] = linked_ids
            resolved["source_quotes"] = resolved_quotes
            resolved_items.append(resolved)
            if linked_ids != item.get("source_chapter_ids", []) or resolved_quotes != item.get("source_quotes", []):
                repairs.append(resolved)
        if repairs:
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            with self.store._connect(self.project_id) as conn:
                for item in repairs:
                    positions = [chapters[cid].get("position", 0) for cid in item["source_chapter_ids"]]
                    order_start = min([int(item.get("order_start") or 0), *positions]) if positions else int(item.get("order_start") or 0)
                    conn.execute(
                        "UPDATE knowledge_items SET source_chapter_ids=?,source_quotes=?,order_start=?,updated_at=? "
                        "WHERE id=? AND active=1",
                        (json.dumps(item["source_chapter_ids"], ensure_ascii=False),
                         json.dumps(item["source_quotes"], ensure_ascii=False), order_start, now, item["id"]),
                    )
        items = resolved_items
        if len(json.dumps(items, ensure_ascii=False)) > 50000:
            raise ValueError("所选知识内容过长，请减少卡片后分次合并")
        return items

    def _normalize_merge_state_changes(self, parsed: dict, items: list[dict], related: list[dict],
                                       evidence_chapters: list[dict], merged_type: str,
                                       merged_title: str) -> tuple[list[dict], list[str]]:
        """Turn model suggestions into evidence-bound, user-reviewable state changes."""
        if merged_type != "character":
            return [], []
        raw_changes = parsed.get("state_changes") if isinstance(parsed, dict) else []
        if not isinstance(raw_changes, list):
            return [], ["模型没有按约定返回阶段状态数组，未自动生成状态候选。"]
        chapters = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        source_cards = {item["id"]: item for item in items}
        related_plots = {item["id"]: item for item in related if item.get("type") == "plot"}
        all_plots = {item["id"]: item for item in eligible_knowledge(self.store, self.project_id)
                     if item.get("type") == "plot"}
        allowed_chapters = {cid for item in items for cid in item.get("source_chapter_ids", []) if cid in chapters}
        allowed_chapters.update(chapter["id"] for chapter in evidence_chapters if chapter.get("id") in chapters)
        warnings, result = [], []
        for index, raw in enumerate(raw_changes[:20]):
            if not isinstance(raw, dict):
                continue
            state_key = str(raw.get("state_key") or "").strip()[:200]
            state_after = str(raw.get("state_after") or "").strip()[:1200]
            if not state_key or not state_after:
                warnings.append(f"第{index + 1}条阶段状态缺少“状态字段”或“变化后”，已跳过。")
                continue
            source_ids = [value for value in raw.get("source_knowledge_ids", [])
                          if isinstance(value, str) and value in source_cards]
            if not source_ids:
                source_ids = list(source_cards)
            existing_event_id = str(raw.get("existing_event_id") or "").strip()
            existing_event = related_plots.get(existing_event_id) or all_plots.get(existing_event_id)
            raw_quotes = [str(value).strip()[:800] for value in (raw.get("source_quotes") or [])
                          if isinstance(value, str) and value.strip()][:8]
            requested_chapter = str(raw.get("source_chapter_id") or "").strip()
            chapter_candidates = []
            if requested_chapter in allowed_chapters:
                chapter_candidates.append(requested_chapter)
            for item_id in source_ids:
                chapter_candidates.extend(cid for cid in source_cards[item_id].get("source_chapter_ids", [])
                                          if cid in allowed_chapters)
            chapter_candidates.extend(allowed_chapters)
            chapter_candidates = sorted(set(chapter_candidates),
                                        key=lambda cid: int(chapters[cid].get("position") or 0), reverse=True)
            chapter_id, quotes = "", []
            if existing_event:
                chapter_id = next((cid for cid in existing_event.get("source_chapter_ids", []) if cid in chapters), "")
                quotes = list(existing_event.get("source_quotes") or [])[:8]
            else:
                candidate_quotes = raw_quotes or [quote for item_id in source_ids
                                                  for quote in source_cards[item_id].get("source_quotes", [])]
                for cid in chapter_candidates:
                    located = [self._locate_source_quote(quote, chapters[cid].get("text") or "")
                               for quote in candidate_quotes]
                    located = list(dict.fromkeys(value for value in located if value))[:8]
                    if located:
                        chapter_id, quotes = cid, located
                        break
                if chapter_id and quotes:
                    matches = [plot for plot in all_plots.values()
                               if chapter_id in plot.get("source_chapter_ids", [])
                               and set(quotes).intersection(plot.get("source_quotes", []))]
                    if len(matches) == 1:
                        existing_event = matches[0]
                        existing_event_id = existing_event["id"]
                        quotes = list(existing_event.get("source_quotes") or quotes)[:8]
            if not chapter_id or not quotes:
                warnings.append(f"阶段状态“{state_key}”缺少可定位的原文依据，未生成候选。")
                continue
            persistence = str(raw.get("persistence") or "unknown").strip().lower()
            if persistence not in {"ongoing", "temporary", "permanent", "unknown"}:
                persistence = "unknown"
            before = str(raw.get("state_before") or "").strip()[:1200]
            title = str(raw.get("title") or f"{merged_title}：{state_key}发生变化").strip()[:300]
            summary = str(raw.get("summary") or (
                f"{merged_title}的“{state_key}”从“{before}”变为“{state_after}”。" if before
                else f"{merged_title}的“{state_key}”更新为“{state_after}”。"
            )).strip()[:4000]
            result.append({
                "id": "ksc_" + uuid4().hex[:20], "title": title, "summary": summary,
                "character_title": str(raw.get("character_title") or merged_title).strip()[:300],
                "state_key": state_key, "state_before": before, "state_after": state_after,
                "change_reason": str(raw.get("change_reason") or "").strip()[:1200],
                "persistence": persistence, "source_knowledge_ids": source_ids,
                "source_chapter_id": chapter_id, "source_chapter_title": chapters[chapter_id]["title"],
                "source_quotes": quotes, "existing_event_id": existing_event_id if existing_event else "",
            })
        return result, warnings

    @staticmethod
    def _edited_merge_state_changes(proposal: dict, edited: dict) -> list[dict]:
        available = {item["id"]: item for item in proposal.get("state_changes") or [] if isinstance(item, dict)}
        submitted = edited.get("state_changes") if "state_changes" in edited else list(available.values())
        if not isinstance(submitted, list) or len(submitted) > 20:
            raise ValueError("阶段状态候选格式无效或超过20条")
        result = []
        for raw in submitted:
            if not isinstance(raw, dict) or raw.get("id") not in available:
                raise ValueError("阶段状态候选已改变，请重新打开合并草稿")
            base = dict(available[raw["id"]])
            for key, limit in (("title", 300), ("summary", 4000), ("character_title", 300),
                               ("state_key", 200), ("state_before", 1200),
                               ("state_after", 1200), ("change_reason", 1200)):
                if key in raw:
                    base[key] = str(raw[key] or "").strip()[:limit]
            if not base.get("state_key") or not base.get("state_after"):
                raise ValueError("保留的阶段状态必须填写“状态字段”和“变化后”")
            persistence = str(raw.get("persistence") or base.get("persistence") or "unknown").lower()
            base["persistence"] = persistence if persistence in {"ongoing", "temporary", "permanent", "unknown"} else "unknown"
            result.append(base)
        return result

    def save_merge(self, parsed: dict, items: list[dict], related: list[dict] | None = None,
                   evidence_chapters: list[dict] | None = None) -> dict:
        raw = parsed.get("item") if isinstance(parsed, dict) else None
        if not isinstance(raw, dict) or not str(raw.get("summary") or "").strip():
            raise ValueError("模型未生成有效的合并草稿")
        # 不依赖模型重新抄写引用；完整保留每张原卡片及其全部出处。
        related, evidence_chapters = related or [], evidence_chapters or []
        merged_type = raw.get("type") if raw.get("type") in KNOWLEDGE_TYPES - {"plot"} else items[0]["type"]
        merged_title = str(raw.get("title") or items[0]["title"])[:300]
        state_changes, state_warnings = self._normalize_merge_state_changes(
            parsed, items, related, evidence_chapters, merged_type, merged_title)
        proposal = {"id": "km_" + uuid4().hex[:24], "status": "pending", "created_at": time.time(),
                    "item_ids": [item["id"] for item in items], "originals": items,
                    "related": related, "related_knowledge_ids": [item["id"] for item in related],
                    "evidence_chapters": [{"id": chapter["id"], "title": chapter["title"],
                                           "position": chapter.get("position", 0)} for chapter in evidence_chapters],
                    "max_order": max(item["order_end"] for item in items),
                    "item": {"type": merged_type,
                             "title": merged_title,
                             "summary": str(raw["summary"])[:4000],
                             "details": raw.get("details") if isinstance(raw.get("details"), dict) else {}},
                    "state_changes": state_changes, "state_change_warnings": state_warnings,
                    **self.snapshot_sources(items + related, evidence_chapters)}
        return self.put("merge", proposal)

    def _apply_merge_state_changes(self, conn, proposal: dict, merged: dict,
                                   changes: list[dict], automatic: bool,
                                   current_plots: dict[str, dict] | None = None) -> tuple[list[dict], list[dict]]:
        created, updated = [], []
        if not changes:
            return created, updated
        # 调用方在写事务开始前读取，避免 SQLite 同一项目的第二连接与当前写锁互相等待。
        current_plots = current_plots or {}
        for change in changes:
            details = {
                "event_type": "character_state_change",
                "affected_character_titles": [change.get("character_title") or merged["title"]],
                "state_key": change["state_key"], "state_before": change.get("state_before", ""),
                "state_after": change["state_after"], "change_reason": change.get("change_reason", ""),
                "persistence": change.get("persistence", "unknown"),
                "interpretation_status": "suggested" if automatic else "confirmed",
            }
            existing = current_plots.get(change.get("existing_event_id"))
            if existing:
                before = {key: existing.get(key) for key in ("title", "summary", "details", "review_status")}
                merged_details = {**(existing.get("details") or {}), **details}
                after = {
                    "title": change["title"], "summary": change["summary"], "details": merged_details,
                    "review_status": existing.get("review_status", "auto") if automatic else "confirmed",
                }
                conn.execute(
                    "UPDATE knowledge_items SET title=?,summary=?,details=?,review_status=?,updated_at=? WHERE id=? AND active=1",
                    (after["title"], after["summary"], json.dumps(after["details"], ensure_ascii=False),
                     after["review_status"], time.strftime("%Y-%m-%d %H:%M:%S"), existing["id"]),
                )
                updated.append({"id": existing["id"], "before": before, "after": after})
                continue
            chapter_id = change["source_chapter_id"]
            event = self.store.save_knowledge(
                self.project_id, [{
                    "type": "plot", "title": change["title"], "summary": change["summary"],
                    "details": details, "source_quotes": change["source_quotes"],
                    "chapter_id": chapter_id,
                }], [chapter_id], "auto" if automatic else "confirmed",
                append_only=True, merge_same_name=False, trust_source_metadata=True, _conn=conn,
            )
            if not event:
                raise ValueError(f"阶段状态“{change['state_key']}”无法写入剧情索引，请检查其原文依据")
            created.append({"id": event[0]["id"], "fingerprint": knowledge_fingerprint(event[0])})
        return created, updated

    @staticmethod
    def _transfer_character_state_references(conn, originals: list[dict], merged: dict) -> list[dict]:
        changes = []
        source_names = set()
        for source in originals:
            source_names.add(str(source.get("title") or "").strip().casefold())
            source_names.update(str(value).strip().casefold() for value in
                                (source.get("details") or {}).get("aliases") or [] if str(value).strip())
        source_names.discard("")
        rows = conn.execute("SELECT id,details FROM knowledge_items WHERE active=1 AND type='plot'").fetchall()
        for stored in rows:
            row = dict(stored)
            try:
                before = json.loads(row.get("details") or "{}")
            except (TypeError, json.JSONDecodeError):
                before = {}
            if before.get("event_type") != "character_state_change":
                continue
            affected = [str(value).strip() for value in before.get("affected_character_titles") or [] if str(value).strip()]
            if not source_names.intersection(value.casefold() for value in affected):
                continue
            after = dict(before)
            after["affected_character_titles"] = list(dict.fromkeys([*affected, merged["title"]]))
            conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=? AND active=1",
                         (json.dumps(after, ensure_ascii=False), time.strftime("%Y-%m-%d %H:%M:%S"), row["id"]))
            changes.append({"id": row["id"], "before": before, "after": after})
        return changes

    def apply_merge(self, proposal_id: str, edited: dict, *, automatic: bool = False) -> dict:
        proposal = self.get(proposal_id)
        if not proposal or proposal.get("status") != "pending" or "originals" not in proposal:
            raise ValueError("待确认的合并草稿不存在")
        if not self.sources_current(proposal):
            raise ValueError("合并来源已改变，请重新选择卡片生成草稿")
        originals = self.merge_inputs(proposal["item_ids"])
        item = dict(proposal["item"])
        for key in ("type", "title", "summary"):
            if key in edited: item[key] = str(edited[key]).strip()
        if not item.get("summary") or len(item["summary"]) > 4000 or item["type"] not in KNOWLEDGE_TYPES - {"plot"}:
            raise ValueError("合并内容不能为空、超过4000字或使用无效类型")
        sources = list(dict.fromkeys(cid for source in originals for cid in source["source_chapter_ids"]))
        item["source_quotes"] = list(dict.fromkeys(q for source in originals for q in source["source_quotes"]))
        # “生成时参考过”不是明确知识关系。参考内容已完整保存在合并记录中，
        # 不再把它们伪装成统一名为“相关”的画布连线。
        clean_details = {key: value for key, value in (item.get("details") or {}).items()
                         if key not in {"knowledge_relations", "related_knowledge_ids"}}
        # 细分归属于卡片大类。合并同类卡片时取并集，避免用户已经标注的细分丢失。
        merged_tags = list(clean_details.get("tags") or [])
        for source in originals:
            if source.get("type") == item["type"]:
                merged_tags.extend((source.get("details") or {}).get("tags") or [])
        clean_details["tags"] = self.store._normalize_knowledge_tags(merged_tags)
        from .tag_periods import periods_for
        # Retain every original interval, including repeated periods for the same tag.
        merged_periods = []
        canonical_tags = {tag.casefold(): tag for tag in clean_details["tags"]}
        for source in originals:
            if source.get("type") != item["type"]:
                continue
            for period in periods_for(source.get("details") or {}):
                tag = canonical_tags.get(period["tag"].casefold())
                if tag:
                    period = {"tag": tag, **{key: period.get(key, "") for key in
                              ("valid_from_chapter_id", "invalid_from_chapter_id")}}
                    if period not in merged_periods:
                        merged_periods.append(period)
        clean_details["tag_periods"] = merged_periods
        item["details"] = {**clean_details, "merged_from": proposal["item_ids"],
                           "source_history": [compact_knowledge(source) for source in originals]}
        state_changes = self._edited_merge_state_changes(proposal, edited) if item["type"] == "character" else []
        current_plots = ({plot["id"]: plot for plot in self.store.list_knowledge(self.project_id, "plot")}
                         if state_changes else {})
        active_before = [current for current in self.store.list_knowledge(self.project_id)
                         if current.get("type") != "plot"]
        source_ids = set(proposal["item_ids"])
        edges_before = self._relation_snapshot(self.relation_edges(active_before))
        affected_before = [edge for edge in edges_before
                           if edge["source_id"] in source_ids or edge["target_id"] in source_ids]
        unaffected = [edge for edge in edges_before if edge not in affected_before]
        with self.store._connect(self.project_id) as conn:
            # 显式合并必须生成独立结果。若复用某张同名来源卡的 ID，随后归档来源时
            # 会把合并结果本身一并隐藏，并且用户编辑过的合并摘要也会被同名保护丢弃。
            saved = self.store.save_knowledge(
                self.project_id, [item], sources, "auto" if automatic else "confirmed",
                append_only=True, merge_same_name=False, trust_source_metadata=True, _conn=conn,
            )[0]
            self.store._extend_knowledge_tag_catalog(
                card_type=item["type"], card_tags=clean_details["tags"], conn=conn)
            # 完整引用不会被普通卡片的5条上限截掉。
            conn.execute("UPDATE knowledge_items SET source_quotes=? WHERE id=?", (json.dumps(item["source_quotes"], ensure_ascii=False), saved["id"]))
            saved["source_quotes"] = item["source_quotes"]
            state_events_created, state_events_updated = self._apply_merge_state_changes(
                conn, proposal, saved, state_changes, automatic, current_plots)
            state_reference_changes = self._transfer_character_state_references(conn, originals, saved)
            affected_after = self._transfer_merge_relations(affected_before, source_ids, saved["id"])
            active_after = {current["id"]: current for current in active_before if current["id"] not in source_ids}
            active_after[saved["id"]] = saved
            relation_touch_ids = {saved["id"]} | {
                endpoint for edge in affected_before + affected_after
                for endpoint in (edge["source_id"], edge["target_id"])
            }
            self._write_relation_edges(conn, active_after, unaffected + affected_after, relation_touch_ids)
            conn.executemany("UPDATE knowledge_items SET active=2 WHERE id=? AND active=1", [(item_id,) for item_id in proposal["item_ids"]])
            proposal.update(status="applied", merged_id=saved["id"], merged_fingerprint=knowledge_fingerprint(saved),
                            merge_relation_edges_before=affected_before,
                            merge_relation_edges_after=affected_after,
                            state_events_created=state_events_created,
                            state_events_updated=state_events_updated,
                            state_reference_changes=state_reference_changes)
            from .clues import ClueStore
            proposal["clue_merge_state"] = ClueStore(self.store, self.project_id).transfer_merge(
                conn, source_ids, saved["id"], item["type"])
            self.put("merge", proposal, conn=conn)
        self.reset("知识卡片已合并，下次读取合并后的知识")
        return saved

    def undo_merge(self, proposal_id: str) -> None:
        proposal = self.get(proposal_id)
        if not proposal or proposal.get("status") != "applied" or "merged_id" not in proposal:
            raise ValueError("可撤销的合并记录不存在")
        current = {item["id"]: item for item in self.store.list_knowledge(self.project_id, include_merged_sources=True)}
        merged = current.get(proposal["merged_id"])
        if not merged or merged["active"] != 1 or knowledge_fingerprint(merged) != proposal["merged_fingerprint"]:
            raise ValueError("合并卡片已修改、删除或再次合并，不能直接撤销；请先处理后续操作")
        if any(current.get(item_id, {}).get("active") != 2 for item_id in proposal["item_ids"]):
            raise ValueError("原卡片状态已改变，不能直接撤销")
        affected_after = self._relation_snapshot(proposal.get("merge_relation_edges_after") or [])
        affected_before = self._relation_snapshot(proposal.get("merge_relation_edges_before") or [])
        current_edges = self._relation_snapshot(self.relation_edges(
            [item for item in current.values() if item.get("active") == 1]))
        merged_edges = [edge for edge in current_edges
                        if merged["id"] in (edge["source_id"], edge["target_id"])]
        if "merge_relation_edges_after" in proposal and merged_edges != affected_after:
            raise ValueError("合并后的卡片关联已被修改，不能安全撤销；请先处理后续关联操作")
        for change in proposal.get("state_reference_changes") or []:
            event = current.get(change["id"])
            if not event or event.get("active") != 1 or (event.get("details") or {}) != change.get("after"):
                raise ValueError("合并后的人物状态引用已被修改，不能安全撤销")
        for change in proposal.get("state_events_updated") or []:
            event = current.get(change["id"])
            after = change.get("after") or {}
            if (not event or event.get("active") != 1
                    or any(event.get(key) != after.get(key) for key in ("title", "summary", "details", "review_status"))):
                raise ValueError("合并生成的阶段状态已被修改，不能安全撤销")
        for created in proposal.get("state_events_created") or []:
            event = current.get(created["id"])
            if not event or event.get("active") != 1 or knowledge_fingerprint(event) != created.get("fingerprint"):
                raise ValueError("合并生成的阶段状态已被修改，不能安全撤销")
        with self.store._connect(self.project_id) as conn:
            from .clues import ClueStore
            ClueStore(self.store, self.project_id).undo_merge(conn, proposal.get("clue_merge_state"))
            conn.execute("UPDATE knowledge_items SET active=0 WHERE id=?", (merged["id"],))
            conn.executemany("UPDATE knowledge_items SET active=1 WHERE id=?", [(item_id,) for item_id in proposal["item_ids"]])
            if "merge_relation_edges_before" in proposal:
                unaffected = [edge for edge in current_edges
                              if merged["id"] not in (edge["source_id"], edge["target_id"])]
                restored_items = {item_id: item for item_id, item in current.items()
                                  if item.get("active") == 1 and item_id != merged["id"]}
                restored_items.update({item_id: current[item_id] for item_id in proposal["item_ids"]})
                relation_touch_ids = set(proposal["item_ids"]) | {
                    endpoint for edge in affected_before + affected_after
                    for endpoint in (edge["source_id"], edge["target_id"])
                }
                self._write_relation_edges(conn, restored_items, unaffected + affected_before, relation_touch_ids)
            for change in proposal.get("state_reference_changes") or []:
                conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=? AND active=1",
                             (json.dumps(change.get("before") or {}, ensure_ascii=False),
                              time.strftime("%Y-%m-%d %H:%M:%S"), change["id"]))
            for change in proposal.get("state_events_updated") or []:
                before = change.get("before") or {}
                conn.execute(
                    "UPDATE knowledge_items SET title=?,summary=?,details=?,review_status=?,updated_at=? WHERE id=? AND active=1",
                    (before.get("title", ""), before.get("summary", ""),
                     json.dumps(before.get("details") or {}, ensure_ascii=False), before.get("review_status", "auto"),
                     time.strftime("%Y-%m-%d %H:%M:%S"), change["id"]),
                )
            for created in proposal.get("state_events_created") or []:
                conn.execute("UPDATE knowledge_items SET active=0,updated_at=? WHERE id=? AND active=1",
                             (time.strftime("%Y-%m-%d %H:%M:%S"), created["id"]))
            proposal["status"] = "undone"
            self.put("merge", proposal, conn=conn)
        self.reset("用户已撤销知识合并")

    def audit_signature(self) -> str:
        # 删除/新加知识或修改任一正文后不能偷偷续用旧检查进度。
        return digest({"chapters": [(c["id"], c["version"], c["position"]) for c in self.store.list_chapters(self.project_id)],
                       "knowledge": [(k["id"], knowledge_fingerprint(k)) for k in self.store.list_knowledge(self.project_id)]})

    def start_audit(self, restart: bool = False, chapter_ids: list[str] | None = None,
                    audit_id: str = "", chapter_char_limit: int = 30000) -> dict:
        previous = self.latest("audit")
        if audit_id:
            if not previous or previous["id"] != audit_id:
                raise ValueError("检查报告已切换或不属于本小说，请刷新后重试")
            if chapter_ids is not None:
                raise ValueError("继续或重查报告时不能同时改变章节范围，请另行开始勾选章节检查")
            if previous.get("scope", "all") == "selected":
                chapter_ids = previous.get("selected_chapter_ids") or [cid for group in previous["groups"] for cid in group]
        all_chapters = self.store.list_chapters(self.project_id)
        if chapter_ids is not None:
            selected_ids = set(chapter_ids)
            if not selected_ids:
                raise ValueError("请先勾选需要检查的章节，空勾选不会改为检查全文")
            if selected_ids - {c["id"] for c in all_chapters}:
                raise ValueError("勾选章节已删除或不属于本小说，请刷新后重选")
            chapters = [c for c in all_chapters if c["id"] in selected_ids]
            if any(not c["text"].strip() for c in chapters):
                raise ValueError("勾选章节包含空白正文，请取消勾选空章节")
            scope = "selected"
        else:
            chapters = [c for c in all_chapters if c["text"].strip()]
            scope = "all"
        # 显式选择不同范围开启新报告，绝不续查上次的全文/其他章节。
        if previous and chapter_ids is not None:
            previous_ids = {cid for group in previous["groups"] for cid in group}
            if previous.get("scope", "all") != scope or previous_ids != {c["id"] for c in chapters}:
                previous = None
        signature = self.audit_signature()
        if not restart and previous:
            if previous["signature"] != signature:
                raise ValueError("正文或知识已改变，请点击“重新检查本范围”；已有检查报告仍保留")
            if previous["status"] == "done":
                return previous
            previous.update(status="running", error="")
            return self.put("audit", previous)
        if not chapters:
            raise ValueError("没有可检查的正文，请先导入或保存章节")
        groups = group_complete_chapters(chapters, 2000, chapter_char_limit)
        audit = {"id": "ka_" + uuid4().hex[:24], "status": "running", "created_at": time.time(),
                 "signature": signature, "groups": [[c["id"] for c in group] for group in groups],
                 "scope": scope, "selected_chapter_ids": [c["id"] for c in chapters],
                 "chapter_titles": {c["id"]: c["title"] for c in chapters},
                 "checked_ids": [], "next_group": 0, "findings": [], "error": "",
                 "input_char_limit": chapter_char_limit + 40000}
        return self.put("audit", audit)

    def audit_inputs(self, group_ids: list[str], input_char_limit: int = 70000) -> tuple[list[dict], list[dict]]:
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        group = [chapters[cid] for cid in group_ids]
        # 查漏允许看到后文的现有卡片，但必须按来源阶段判断是否已覆盖本章。
        # 所有直接源于本批的卡片都提供；其他章节相关卡片辅助去重。
        items = self.store.list_knowledge(self.project_id)
        from .clues import ClueStore
        items = ClueStore(self.store, self.project_id).project(items, max(c["position"] for c in group))
        direct = [k for k in items if set(group_ids).intersection(k["source_chapter_ids"])]
        related, _ = select_context(items, "\n".join(c["text"] for c in group), max_chars=10000)
        seen = {k["id"] for k in direct}
        evidence = direct + [k for k in related if k["id"] not in seen]
        if len(json.dumps(evidence, ensure_ascii=False)) + sum(len(c["text"]) for c in group) > input_char_limit:
            raise ValueError("本批正文和知识过长，检查在此暂停；请先减少重复知识或拆分章节后重新检查")
        return group, evidence

    def save_audit_group(self, audit: dict, parsed: dict, group: list[dict]) -> dict:
        audit = dict(audit, findings=list(audit["findings"]), checked_ids=list(audit["checked_ids"]),
                     discarded_findings=list(audit.get("discarded_findings") or []), error="")
        if self.audit_signature() != audit["signature"]:
            raise ValueError("检查期间正文或知识已改变，请重新检查本范围")
        raw_items = parsed.get("findings") if isinstance(parsed, dict) else None
        if not isinstance(raw_items, list) or len(raw_items) > 50:
            raise ValueError("模型未返回有效的遗漏检查结果")
        for raw in raw_items:
            if not isinstance(raw, dict):
                audit["discarded_findings"].append({"title": "无法解析的候选", "reason": "模型返回的候选格式无效",
                                                     "source_quotes": [], "source_chapter_ids": [c["id"] for c in group]})
                continue
            raw_quotes = raw.get("source_quotes")
            located, source_ids = [], []
            if isinstance(raw_quotes, list):
                for raw_quote in raw_quotes[:10]:
                    if not isinstance(raw_quote, str) or not raw_quote.strip() or len(raw_quote) > 800:
                        continue
                    for chapter in group:
                        exact = self._locate_source_quote(raw_quote, chapter["text"])
                        if exact:
                            if exact not in located: located.append(exact)
                            if chapter["id"] not in source_ids: source_ids.append(chapter["id"])
                            break
            item_type = raw.get("type") if raw.get("type") in KNOWLEDGE_TYPES else "plot"
            summary = str(raw.get("summary") or "").strip()
            if not located or not summary:
                audit["discarded_findings"].append({
                    "title": str(raw.get("title") or "未命名候选")[:300],
                    "reason": "没有可在本批正文定位的有效引文" if not located else "候选没有具体内容",
                    "source_quotes": [str(value).strip()[:800] for value in (raw_quotes if isinstance(raw_quotes, list) else [])[:8]
                                      if isinstance(value, str) and value.strip()],
                    "source_chapter_ids": [c["id"] for c in group],
                })
                continue
            quotes = located[:8]
            key = digest([source_ids, quotes, summary])
            if any(item.get("key") == key for item in audit["findings"]): continue
            audit["findings"].append({"id": "kf_" + uuid4().hex[:24], "key": key, "status": "pending",
                "type": item_type, "chapter_id": str(raw.get("chapter_id") or ""),
                "title": str(raw.get("title") or "疑似遗漏")[:300], "summary": summary[:4000],
                "reason": str(raw.get("reason") or "需要人工判断现有知识是否已覆盖")[:1200],
                "details": raw.get("details") if isinstance(raw.get("details"), dict) else {},
                "source_quotes": quotes, "source_chapter_ids": source_ids,
                "chapter_versions": {c["id"]: c["version"] for c in group if c["id"] in source_ids}})
        audit["discarded_findings"] = audit["discarded_findings"][-200:]
        audit["checked_ids"].extend(c["id"] for c in group)
        audit["next_group"] += 1
        if audit["next_group"] >= len(audit["groups"]): audit["status"] = "done"
        return self.put("audit", audit)

    def review_audit(self, audit_id: str, decisions: list[dict]) -> dict:
        audit = self.get(audit_id)
        if not audit or "findings" not in audit or audit.get("status") == "cleared": raise ValueError("检查报告不存在或已清空")
        if audit["signature"] != self.audit_signature():
            raise ValueError("检查后正文或知识已改变，请重新检查，避免补入重复或过时知识")
        findings = {item["id"]: item for item in audit["findings"]}
        ids = [str(decision.get("id") or "") for decision in decisions]
        if not ids or len(ids) != len(set(ids)) or any(i not in findings or findings[i]["status"] != "pending" for i in ids):
            raise ValueError("请选择尚未处理的疑似遗漏，不能重复提交")
        with self.store._connect(self.project_id) as conn:
            for decision in decisions:
                finding = findings[decision["id"]]
                if decision.get("accepted") is not True:
                    finding["status"] = "dismissed"; continue
                item = dict(finding)
                selected_type = str(decision.get("type") or item.get("type") or "plot").lower()
                if selected_type not in KNOWLEDGE_TYPES:
                    raise ValueError("疑似遗漏的知识类型无效")
                item["type"] = selected_type
                item["summary"] = str(decision.get("summary", item["summary"])).strip()
                if not item["summary"] or len(item["summary"]) > 4000: raise ValueError("补入内容不能为空或超过4000字")
                saved = self.store.save_knowledge(self.project_id, [item], item["source_chapter_ids"], "confirmed", append_only=True, _conn=conn)[0]
                finding.update(status="added", saved_id=saved["id"], type=selected_type)
            self.put("audit", audit, conn=conn)
        # 自己明确补入的结果可以继续检查剩余章节；其他变更仍会触发重查。
        audit["signature"] = self.audit_signature()
        self.put("audit", audit)
        self.reset("用户确认补入了遗漏知识")
        from .clues import ClueStore
        ClueStore(self.store, self.project_id).match({f["saved_id"] for f in findings.values() if f.get("saved_id")})
        return audit
