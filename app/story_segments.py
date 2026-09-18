"""剧情分段画布。

知识卡片和关联仍是全书唯一数据；这里只保存每段的显示成员、坐标和
被用户隐藏的关联。因此“移出本段”不会删除卡片或改变 AI 检索事实。
"""
from __future__ import annotations

import json
import copy
import math
import time
from contextlib import nullcontext
from uuid import uuid4


class StorySegments:
    DOCUMENT_ID = "story_segments_v1"
    ENTITY_TYPES = {"character", "relationship", "term", "scene"}

    def __init__(self, store, project_id: str):
        self.store, self.project_id = store, project_id

    def _read(self, conn=None) -> dict:
        with (nullcontext(conn) if conn is not None else self.store._connect(self.project_id)) as db:
            row = db.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (self.DOCUMENT_ID,)).fetchone()
        if row:
            try:
                value = json.loads(row["data"])
                if isinstance(value, dict):
                    value.setdefault("segments", [])
                    return value
            except (TypeError, json.JSONDecodeError):
                pass
        return {"version": 1, "segments": []}

    @staticmethod
    def _write(conn, data: dict) -> None:
        data["updated_at"] = time.time()
        conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data",
                     (StorySegments.DOCUMENT_ID, "story_segments", json.dumps(data, ensure_ascii=False)))

    def _chapters(self) -> list[dict]:
        return self.store.list_chapters(self.project_id)

    def _cards(self) -> dict[str, dict]:
        return {item["id"]: item for item in self.store.list_knowledge(self.project_id)
                if item.get("type") in self.ENTITY_TYPES}

    @staticmethod
    def _evidence(card: dict, chapter_ids: set[str]) -> bool:
        return bool(chapter_ids.intersection(card.get("source_chapter_ids") or []))

    def _ordered(self, data: dict, chapters: dict[str, dict]) -> list[dict]:
        return sorted(data.get("segments") or [], key=lambda segment: min(
            (chapters[cid]["position"] for cid in segment.get("chapter_ids") or [] if cid in chapters),
            default=10**9))

    def _reconcile(self, data: dict) -> bool:
        """建库后把新卡片同步到已有分段；人工移出决定始终优先。"""
        chapters = {chapter["id"]: chapter for chapter in self._chapters()}
        cards = self._cards()
        ordered = self._ordered(data, chapters)
        changed, previous = False, None
        ever_active: set[str] = set()
        for index, segment in enumerate(ordered):
            segment["position"] = index + 1
            nodes = segment.setdefault("nodes", {})
            chapter_ids = set(segment.get("chapter_ids") or [])
            for stale in set(nodes) - set(cards):
                nodes.pop(stale, None); changed = True
            for card_id, card in cards.items():
                evidence = self._evidence(card, chapter_ids)
                node = nodes.get(card_id)
                if node:
                    # 还没有在本段被用户处理过的“继承”节点，应继续跟随上一段的
                    # 显示状态。这样用户回到前一段移出卡片时，已经创建的后续
                    # 分段也会连贯更新；若卡片恰好在后段再次出现，则改为询问恢复。
                    inherited = (previous or {}).get("nodes", {}).get(card_id)
                    if node.get("origin") == "inherited" and previous is not None:
                        inherited_active = bool(inherited and inherited.get("active"))
                        if evidence and not inherited_active:
                            replacement = {
                                "active": False, "was_active": bool(node.get("was_active")),
                                "origin": "reappeared", "evidence": True,
                                "pending_restore": True, "restore_decision": "",
                                "x": node.get("x"), "y": node.get("y"),
                            }
                            if node != replacement:
                                nodes[card_id] = node = replacement; changed = True
                        elif node.get("active") != inherited_active:
                            node["active"] = inherited_active
                            node["was_active"] = bool(node.get("was_active") or inherited_active)
                            changed = True
                    if node.get("evidence") != evidence:
                        node["evidence"] = evidence; changed = True
                    if evidence and not node.get("active") and not node.get("restore_decision"):
                        if not node.get("pending_restore"):
                            node["pending_restore"] = True; changed = True
                    if node.get("active") or node.get("was_active"):
                        ever_active.add(card_id)
                    continue
                inherited = (previous or {}).get("nodes", {}).get(card_id)
                if inherited and inherited.get("active"):
                    nodes[card_id] = {"active": True, "was_active": True, "origin": "inherited", "evidence": evidence,
                                      "x": inherited.get("x"), "y": inherited.get("y")}
                    ever_active.add(card_id); changed = True
                elif evidence and card_id in ever_active:
                    nodes[card_id] = {"active": False, "origin": "reappeared", "evidence": True,
                                      "pending_restore": True, "restore_decision": ""}
                    changed = True
                elif evidence:
                    nodes[card_id] = {"active": True, "was_active": True, "origin": "new", "evidence": True}
                    ever_active.add(card_id); changed = True
            previous = segment
        data["segments"] = ordered
        return changed

    def overview(self) -> dict:
        with self.store._connect(self.project_id) as conn:
            data = self._read(conn)
            if self._reconcile(data):
                self._write(conn, data)
        chapters = self._chapters()
        cards = self._cards()
        chapter_map = {chapter["id"]: chapter for chapter in chapters}
        public = []
        for segment in data["segments"]:
            ids = [cid for cid in segment.get("chapter_ids") or [] if cid in chapter_map]
            nodes = segment.get("nodes") or {}
            public.append({**segment, "chapter_ids": ids,
                           "chapter_titles": [chapter_map[cid]["title"] for cid in ids],
                           "active_count": sum(1 for node in nodes.values() if node.get("active")),
                           "pending_count": sum(1 for node in nodes.values() if node.get("pending_restore"))})
        return {"segments": public,
                "chapters": [{key: chapter[key] for key in ("id", "title", "position")} for chapter in chapters],
                "cards": [{"id": card["id"], "type": card["type"], "title": card["title"],
                           "summary": card["summary"], "source_chapter_ids": card.get("source_chapter_ids") or []}
                          for card in cards.values()]}

    def create(self, name: str, chapter_ids: list[str]) -> dict:
        chapters = {chapter["id"]: chapter for chapter in self._chapters()}
        ids = list(dict.fromkeys(str(cid) for cid in chapter_ids if cid in chapters))
        if not ids:
            raise ValueError("请选择这段剧情包含的章节")
        ids.sort(key=lambda cid: chapters[cid]["position"])
        positions = [chapters[cid]["position"] for cid in ids]
        if positions != list(range(positions[0], positions[-1] + 1)):
            raise ValueError("一段剧情必须选择连续章节")
        title = str(name or "").strip()[:120]
        if not title:
            title = f"{chapters[ids[0]]['title']} — {chapters[ids[-1]]['title']}"
        with self.store._connect(self.project_id) as conn:
            data = self._read(conn)
            used = {cid for segment in data["segments"] for cid in segment.get("chapter_ids") or []}
            if used.intersection(ids):
                raise ValueError("所选章节已属于其他剧情段")
            self._reconcile(data)
            ordered = self._ordered(data, chapters)
            previous = next((segment for segment in reversed(ordered)
                             if max((chapters[cid]["position"] for cid in segment.get("chapter_ids") or [] if cid in chapters), default=0) < positions[0]), None)
            nodes = {}
            if previous:
                for card_id, node in (previous.get("nodes") or {}).items():
                    nodes[card_id] = {"active": bool(node.get("active")), "was_active": bool(node.get("active") or node.get("was_active")), "origin": "inherited",
                                      "evidence": False, "x": node.get("x"), "y": node.get("y")}
            cards = self._cards(); prior_active = {card_id for segment in ordered
                                                   for card_id, node in (segment.get("nodes") or {}).items()
                                                   if node.get("active") or node.get("was_active")}
            for card_id, card in cards.items():
                if not self._evidence(card, set(ids)):
                    continue
                if card_id in nodes and nodes[card_id].get("active"):
                    nodes[card_id]["evidence"] = True
                elif card_id in prior_active:
                    nodes[card_id] = {"active": False, "origin": "reappeared", "evidence": True,
                                      "pending_restore": True, "restore_decision": ""}
                else:
                    nodes[card_id] = {"active": True, "was_active": True, "origin": "new", "evidence": True}
            segment = {"id": "sg_" + uuid4().hex[:24], "name": title, "chapter_ids": ids,
                       "position": len(ordered) + 1, "nodes": nodes,
                       "hidden_edge_ids": list(previous.get("hidden_edge_ids") or []) if previous else [],
                       "created_at": time.time()}
            data["segments"].append(segment); self._reconcile(data); self._write(conn, data)
        return segment

    def delete(self, segment_id: str) -> None:
        with self.store._connect(self.project_id) as conn:
            data = self._read(conn)
            before = len(data["segments"])
            data["segments"] = [segment for segment in data["segments"] if segment["id"] != segment_id]
            if len(data["segments"]) == before:
                raise ValueError("剧情段不存在")
            self._reconcile(data); self._write(conn, data)

    def update_nodes(self, segment_id: str, node_ids: list[str], action: str,
                     restore_relations: bool = True) -> dict:
        if action not in {"add", "exclude", "restore", "dismiss"}:
            raise ValueError("剧情段卡片操作无效")
        cards = self._cards(); ids = list(dict.fromkeys(str(value) for value in node_ids))
        if not ids or any(value not in cards for value in ids):
            raise ValueError("所选卡片已失效，请刷新")
        from .knowledge_tools import KnowledgeTools
        edges = KnowledgeTools(self.store, self.project_id).relation_edges(list(cards.values()))
        with self.store._connect(self.project_id) as conn:
            data = self._read(conn); self._reconcile(data)
            segment = next((value for value in data["segments"] if value["id"] == segment_id), None)
            if not segment:
                raise ValueError("剧情段不存在")
            nodes = segment.setdefault("nodes", {}); hidden = set(segment.setdefault("hidden_edge_ids", []))
            for card_id in ids:
                node = nodes.setdefault(card_id, {"origin": "manual", "evidence": self._evidence(cards[card_id], set(segment["chapter_ids"]))})
                if action == "exclude":
                    node.update(active=False, was_active=bool(node.get("active") or node.get("was_active")),
                                pending_restore=False, restore_decision="excluded", origin="manual")
                elif action == "dismiss":
                    node.update(active=False, pending_restore=False, restore_decision="dismissed")
                else:
                    node.update(active=True, was_active=True, pending_restore=False,
                                restore_decision="restored" if action == "restore" else "",
                                origin="restored" if action == "restore" else "manual")
                    related = {edge["id"] for edge in edges if card_id in (edge["source_id"], edge["target_id"])}
                    if restore_relations:
                        hidden.difference_update(related)
                    else:
                        hidden.update(related)
            segment["hidden_edge_ids"] = sorted(hidden); self._write(conn, data)
        return segment

    def save_positions(self, segment_id: str, raw: dict) -> dict:
        if not isinstance(raw, dict) or len(raw) > 1000:
            raise ValueError("画布位置格式无效")
        with self.store._connect(self.project_id) as conn:
            data = self._read(conn); self._reconcile(data)
            segment = next((value for value in data["segments"] if value["id"] == segment_id), None)
            if not segment:
                raise ValueError("剧情段不存在")
            nodes = segment.setdefault("nodes", {})
            for card_id, point in raw.items():
                if card_id not in nodes or not nodes[card_id].get("active") or not isinstance(point, dict):
                    raise ValueError("只能保存当前剧情段中的卡片位置")
                try:
                    x, y = float(point.get("x")), float(point.get("y"))
                except (TypeError, ValueError):
                    raise ValueError("画布坐标必须是数字") from None
                if not math.isfinite(x) or not math.isfinite(y):
                    raise ValueError("画布坐标无效")
                nodes[card_id]["x"], nodes[card_id]["y"] = round(x, 3), round(y, 3)
            self._write(conn, data)
        return {"positions": {card_id: {"x": node.get("x"), "y": node.get("y")}
                              for card_id, node in segment["nodes"].items() if node.get("active")
                              and node.get("x") is not None and node.get("y") is not None}}

    def transfer_merge(self, conn, source_ids: list[str], merged_id: str) -> dict | None:
        """合并卡片时同步所有分段成员和坐标，不让画布引用消失。"""
        data = self._read(conn); sources = set(source_ids); snapshots = {}
        for segment in data.get("segments") or []:
            nodes = segment.setdefault("nodes", {})
            found = {item_id: copy.deepcopy(nodes[item_id]) for item_id in sources if item_id in nodes}
            if not found:
                continue
            points = [node for node in found.values() if node.get("x") is not None and node.get("y") is not None]
            merged = {"active": any(node.get("active") for node in found.values()),
                      "was_active": any(node.get("active") or node.get("was_active") for node in found.values()),
                      "evidence": any(node.get("evidence") for node in found.values()),
                      "pending_restore": any(node.get("pending_restore") for node in found.values()),
                      "origin": "merged"}
            if points:
                merged.update(x=round(sum(float(node["x"]) for node in points) / len(points), 3),
                              y=round(sum(float(node["y"]) for node in points) / len(points), 3))
            snapshots[segment["id"]] = {"sources": found, "merged_before": copy.deepcopy(nodes.get(merged_id)),
                                          "merged_after": copy.deepcopy(merged)}
            for item_id in sources:
                nodes.pop(item_id, None)
            nodes[merged_id] = merged
        if not snapshots:
            return None
        self._write(conn, data)
        return {"merged_id": merged_id, "segments": snapshots}

    def undo_merge(self, conn, snapshot: dict | None) -> None:
        if not snapshot:
            return
        data = self._read(conn); merged_id = snapshot.get("merged_id", "")
        for segment_id, before in (snapshot.get("segments") or {}).items():
            segment = next((item for item in data.get("segments") or [] if item.get("id") == segment_id), None)
            if not segment:
                raise ValueError("合并后剧情段已改变，不能安全撤销")
            nodes = segment.setdefault("nodes", {})
            if nodes.get(merged_id) != before.get("merged_after"):
                raise ValueError("合并卡片在剧情段中已被修改，不能安全撤销")
            nodes.pop(merged_id, None)
            if before.get("merged_before") is not None:
                nodes[merged_id] = before["merged_before"]
            nodes.update(copy.deepcopy(before.get("sources") or {}))
        self._write(conn, data)
