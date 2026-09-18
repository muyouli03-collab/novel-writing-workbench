"""知识卡片可视化画布的布局、关系和持久化撤销。"""
from __future__ import annotations

import json
import math
import time
from contextlib import nullcontext
from uuid import uuid4

from .knowledge_memory import KnowledgeMemory, eligible_knowledge
from .knowledge_tools import KnowledgeTools


class KnowledgeGraph:
    LAYOUT_ID = "knowledge_graph_layout_v1"
    HISTORY_ID = "knowledge_graph_history_v1"
    HISTORY_LIMIT = 50

    def __init__(self, store, project_id: str):
        self.store, self.project_id = store, project_id
        self.memory = KnowledgeMemory(store, project_id)
        self.tools = KnowledgeTools(store, project_id)

    def _cards(self, *, eligible_only: bool = False) -> dict[str, dict]:
        cards = {item["id"]: item for item in self.store.list_knowledge(self.project_id)
                 if item.get("type") != "plot"}
        if eligible_only:
            eligible_ids = {item["id"] for item in eligible_knowledge(self.store, self.project_id)
                            if item.get("type") != "plot"}
            cards = {item_id: item for item_id, item in cards.items() if item_id in eligible_ids}
        return cards

    @staticmethod
    def _decode(row, fallback: dict) -> dict:
        if not row:
            return dict(fallback)
        try:
            value = json.loads(row["data"])
            return value if isinstance(value, dict) else dict(fallback)
        except (TypeError, json.JSONDecodeError):
            return dict(fallback)

    def _document(self, document_id: str, fallback: dict, *, conn=None) -> dict:
        with (nullcontext(conn) if conn is not None else self.store._connect(self.project_id)) as db:
            row = db.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (document_id,)).fetchone()
        return self._decode(row, fallback)

    @staticmethod
    def _write_document(conn, document_id: str, kind: str, data: dict) -> None:
        conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data",
                     (document_id, kind, json.dumps(data, ensure_ascii=False)))

    def layout(self, *, conn=None) -> dict:
        value = self._document(self.LAYOUT_ID, {"id": self.LAYOUT_ID, "version": 1, "positions": {}}, conn=conn)
        value.setdefault("positions", {})
        return value

    def history(self, *, conn=None) -> dict:
        value = self._document(self.HISTORY_ID, {"id": self.HISTORY_ID, "version": 1, "actions": []}, conn=conn)
        value.setdefault("actions", [])
        return value

    def _push_action(self, action: dict, *, conn) -> dict:
        history = self.history(conn=conn)
        action = {"id": "ga_" + uuid4().hex[:24], "status": "applied", "created_at": time.time(), **action}
        history["actions"] = (history.get("actions") or [])[-(self.HISTORY_LIMIT - 1):] + [action]
        self._write_document(conn, self.HISTORY_ID, "graph_history", history)
        return action

    @staticmethod
    def _latest_action(history: dict) -> dict | None:
        return next((action for action in reversed(history.get("actions") or [])
                     if action.get("status") == "applied"), None)

    def undo_summary(self, *, conn=None) -> dict:
        action = self._latest_action(self.history(conn=conn))
        return {"can_undo": bool(action), "action_id": action.get("id", "") if action else "",
                "label": action.get("label", "") if action else ""}

    def graph(self) -> dict:
        cards = self._cards()
        eligible_ids = set(self._cards(eligible_only=True))
        chapters = {chapter["id"]: chapter for chapter in self.store.list_chapters(self.project_id)}
        nodes = []
        for item in cards.values():
            if item["type"] in {"world", "clue"}:
                continue
            node = dict(item)
            # 和真正参与合并/关联的规则保持一致：来源章节失效的旧卡片也不能操作。
            node["eligible"] = item["id"] in eligible_ids
            node["source_chapters"] = [{"id": cid, "title": chapters[cid]["title"],
                                         "position": chapters[cid]["position"]}
                                        for cid in item.get("source_chapter_ids", []) if cid in chapters]
            nodes.append(node)
        nodes.sort(key=lambda item: (item.get("type", ""), item.get("order_start", 0), item["id"]))
        edges = self.tools.relation_edges(list(cards.values()))
        for node in nodes:
            node["external_relations"] = [
                {"id": other["id"], "title": other["title"], "type": other["type"], "label": edge["label"],
                 "valid_from_chapter_id": edge.get("valid_from_chapter_id", ""),
                 "invalid_from_chapter_id": edge.get("invalid_from_chapter_id", ""),
                 "valid_from_chapter": edge.get("valid_from_chapter"),
                 "invalid_from_chapter": edge.get("invalid_from_chapter"),
                 "temporal_status": edge.get("temporal_status", "active")}
                for edge in edges if node["id"] in (edge["source_id"], edge["target_id"])
                for other in [cards[edge["target_id"] if edge["source_id"] == node["id"] else edge["source_id"]]]
                if other["type"] in {"world", "clue"}]
        layout = self.layout()
        return {"nodes": nodes, "edges": edges, "positions": layout.get("positions", {}),
                "undo": self.undo_summary(), "history_limit": self.HISTORY_LIMIT}

    @staticmethod
    def _clean_positions(raw: dict) -> dict[str, dict]:
        if not isinstance(raw, dict) or len(raw) > 1000:
            raise ValueError("画布位置格式无效")
        result = {}
        for item_id, point in raw.items():
            if not isinstance(point, dict):
                raise ValueError("画布位置格式无效")
            try:
                x, y = float(point.get("x")), float(point.get("y"))
            except (TypeError, ValueError):
                raise ValueError("画布坐标必须是数字") from None
            if not math.isfinite(x) or not math.isfinite(y) or abs(x) > 10_000_000 or abs(y) > 10_000_000:
                raise ValueError("画布坐标超出有效范围")
            result[str(item_id)] = {"x": round(x, 3), "y": round(y, 3)}
        return result

    @staticmethod
    def positions_from_ai_plan(plan: dict, nodes: list[dict]) -> dict:
        """Turn an LLM semantic grouping into deterministic, non-overlapping coordinates."""
        if not isinstance(plan, dict) or not isinstance(plan.get("groups"), list):
            raise ValueError("AI没有返回可用的关系分组，请重试")
        node_map = {str(node.get("id") or ""): node for node in nodes if node.get("id")}
        if not node_map:
            raise ValueError("当前画布没有可排布的卡片")
        assigned: set[str] = set()
        groups = []
        allowed_layouts = {"hub", "hierarchy", "opposition", "sequence", "grid"}
        for group_index, raw_group in enumerate(plan.get("groups")[:100]):
            if not isinstance(raw_group, dict) or not isinstance(raw_group.get("items"), list):
                continue
            items = []
            for item_index, raw_item in enumerate(raw_group.get("items")[:500]):
                if not isinstance(raw_item, dict):
                    continue
                item_id = str(raw_item.get("card_id") or raw_item.get("node_id") or "")
                if item_id not in node_map or item_id in assigned:
                    continue
                try:
                    lane = max(-6, min(6, int(raw_item.get("lane") or 0)))
                except (TypeError, ValueError):
                    lane = 0
                try:
                    rank = max(0, min(500, int(raw_item.get("rank") or item_index)))
                except (TypeError, ValueError):
                    rank = item_index
                items.append({"id": item_id, "lane": lane, "rank": rank,
                              "role": str(raw_item.get("role") or "member")[:30]})
                assigned.add(item_id)
            if not items:
                continue
            try:
                order = int(raw_group.get("order") or group_index)
            except (TypeError, ValueError):
                order = group_index
            layout = str(raw_group.get("layout") or "hub").strip().lower()
            groups.append({"id": str(raw_group.get("id") or f"group_{group_index + 1}")[:80],
                           "title": str(raw_group.get("title") or f"关系组 {group_index + 1}")[:100],
                           "layout": layout if layout in allowed_layouts else "hub",
                           "order": order, "items": items, "fallback": False})

        # A malformed or incomplete model response must not make cards disappear. Put
        # omitted cards into small type-based fallback groups after the semantic groups.
        remaining = [item_id for item_id in node_map if item_id not in assigned]
        type_labels = {"character": "其他人物", "relationship": "其他关系",
                       "term": "其他名词", "scene": "其他场景"}
        by_type: dict[str, list[str]] = {}
        for item_id in remaining:
            by_type.setdefault(str(node_map[item_id].get("type") or "other"), []).append(item_id)
        fallback_order = max([group["order"] for group in groups], default=-1) + 1
        for card_type, item_ids in sorted(by_type.items()):
            item_ids.sort(key=lambda item_id: (str(node_map[item_id].get("title") or ""), item_id))
            for offset in range(0, len(item_ids), 12):
                part = item_ids[offset:offset + 12]
                groups.append({"id": f"fallback_{card_type}_{offset // 12}",
                               "title": type_labels.get(card_type, "其他卡片"), "layout": "grid",
                               "order": fallback_order, "fallback": True,
                               "items": [{"id": item_id, "lane": 0, "rank": index, "role": "member"}
                                         for index, item_id in enumerate(part)]})
                fallback_order += 1
        if not groups:
            raise ValueError("AI没有返回可用的关系分组，请重试")

        def _sort_items(values):
            return sorted(values, key=lambda value: (
                value["rank"], str(node_map[value["id"]].get("title") or ""), value["id"]))

        def _columns(values, lane_gap=360, row_gap=145):
            lanes: dict[int, list[dict]] = {}
            for value in values:
                lanes.setdefault(value["lane"], []).append(value)
            points = {}
            for column, lane in enumerate(sorted(lanes)):
                row = _sort_items(lanes[lane])
                start_y = -(len(row) - 1) * row_gap / 2
                for index, value in enumerate(row):
                    points[value["id"]] = (column * lane_gap, start_y + index * row_gap)
            return points

        def _local_points(group):
            items, layout = group["items"], group["layout"]
            if layout in {"hierarchy", "sequence"}:
                return _columns(items)
            if layout == "opposition":
                # Keep a real gap between camps even when the model used only 0/1 lanes.
                if len({item["lane"] for item in items}) < 2 and len(items) > 1:
                    for index, item in enumerate(_sort_items(items)):
                        item["lane"] = -1 if index < (len(items) + 1) // 2 else 1
                return _columns(items, lane_gap=500)
            if layout == "grid":
                ordered = _sort_items(items)
                columns = max(1, math.ceil(math.sqrt(len(ordered))))
                return {item["id"]: ((index % columns) * 320, (index // columns) * 145)
                        for index, item in enumerate(ordered)}

            ordered = _sort_items(items)
            center_index = next((index for index, item in enumerate(ordered)
                                 if item["role"] in {"center", "hub", "main"}), 0)
            center = ordered.pop(center_index)
            points = {center["id"]: (0.0, 0.0)}
            placed = 0
            ring = 1
            while placed < len(ordered):
                count = min(8 * ring, len(ordered) - placed)
                radius = 380 + (ring - 1) * 310
                for index in range(count):
                    angle = -math.pi / 2 + 2 * math.pi * index / count
                    item = ordered[placed + index]
                    points[item["id"]] = (math.cos(angle) * radius, math.sin(angle) * radius)
                placed += count
                ring += 1
            return points

        prepared = []
        for group in sorted(groups, key=lambda value: (value["order"], value["title"], value["id"])):
            raw_points = _local_points(group)
            xs = [point[0] for point in raw_points.values()]
            ys = [point[1] for point in raw_points.values()]
            min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
            local = {item_id: {"x": round(x - min_x + 40, 3), "y": round(y - min_y + 40, 3)}
                     for item_id, (x, y) in raw_points.items()}
            prepared.append({**group, "local": local,
                             "width": max_x - min_x + 334, "height": max_y - min_y + 188})

        positions = {}
        row_limit = max(2200, math.sqrt(len(node_map)) * 560)
        cursor_x = cursor_y = row_height = 0.0
        output_groups = []
        for group in prepared:
            if cursor_x and cursor_x + group["width"] > row_limit:
                cursor_x = 0.0
                cursor_y += row_height + 260
                row_height = 0.0
            for item_id, point in group["local"].items():
                positions[item_id] = {"x": round(cursor_x + point["x"], 3),
                                      "y": round(cursor_y + point["y"], 3)}
            output_groups.append({"id": group["id"], "title": group["title"],
                                  "layout": group["layout"],
                                  "card_ids": [item["id"] for item in group["items"]],
                                  "fallback": group["fallback"]})
            cursor_x += group["width"] + 280
            row_height = max(row_height, group["height"])
        return {"positions": positions, "groups": output_groups,
                "rationale": str(plan.get("rationale") or "")[:800],
                "unassigned_count": len(remaining)}

    def save_positions(self, raw: dict, *, record_history: bool = True, label: str = "移动知识卡片") -> dict:
        positions = self._clean_positions(raw)
        cards = self._cards()
        if any(item_id not in cards for item_id in positions):
            raise ValueError("卡片已删除或不属于当前小说，请刷新画布")
        with self.store._connect(self.project_id) as conn:
            layout = self.layout(conn=conn)
            current = layout["positions"]
            before = {item_id: current.get(item_id) for item_id in positions}
            changed = {item_id: point for item_id, point in positions.items() if current.get(item_id) != point}
            if not changed:
                return {"positions": current, "undo": self.undo_summary(conn=conn)}
            current.update(changed)
            layout["updated_at"] = time.time()
            self._write_document(conn, self.LAYOUT_ID, "graph_layout", layout)
            if record_history:
                self._push_action({"kind": "move", "label": label[:120],
                                   "before": {item_id: before[item_id] for item_id in changed},
                                   "after": changed}, conn=conn)
            return {"positions": current, "undo": self.undo_summary(conn=conn)}

    @staticmethod
    def _edge_snapshot(edges: list[dict]) -> list[dict]:
        return sorted(({"id": str(edge["id"]), "source_id": str(edge["source_id"]),
                        "target_id": str(edge["target_id"]), "label": str(edge["label"]),
                        "valid_from_chapter_id": str(edge.get("valid_from_chapter_id") or ""),
                        "invalid_from_chapter_id": str(edge.get("invalid_from_chapter_id") or "")}
                       for edge in edges),
                      key=lambda edge: (edge["id"], edge["source_id"], edge["target_id"]))

    def _write_edges(self, edges: list[dict], *, conn) -> None:
        cards = self._cards()
        outgoing = {item_id: [] for item_id in cards}
        degrees = {item_id: 0 for item_id in cards}
        pairs = set()
        for edge in edges:
            source, target, label = edge["source_id"], edge["target_id"], str(edge.get("label") or "").strip()
            pair = frozenset((source, target))
            if source not in cards or target not in cards or source == target:
                raise ValueError("关联卡片已删除或不属于当前小说")
            if pair in pairs:
                raise ValueError("同两张卡片之间只能保留一条关系")
            if not label or len(label) > 80 or "\n" in label or "\r" in label:
                raise ValueError("关系名称必填，最多80字且不能换行")
            valid_from, invalid_from = self.tools._validate_relation_period(
                edge.get("valid_from_chapter_id", ""), edge.get("invalid_from_chapter_id", ""))
            pairs.add(pair); degrees[source] += 1; degrees[target] += 1
            outgoing[source].append({"id": edge["id"], "target_id": target, "label": label,
                                     "valid_from_chapter_id": valid_from,
                                     "invalid_from_chapter_id": invalid_from})
        if any(count > 50 for count in degrees.values()):
            raise ValueError("每张卡片最多关联50张其他卡片")
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        for item_id, item in cards.items():
            details = dict(item.get("details") or {})
            details["knowledge_relations"] = outgoing[item_id]
            details["related_knowledge_ids"] = []
            conn.execute("UPDATE knowledge_items SET details=?,updated_at=? WHERE id=? AND active=1",
                         (json.dumps(details, ensure_ascii=False), now, item_id))

    def _mutate_edges(self, mutate, label: str, relation_layouts: dict[str, str] | None = None) -> dict:
        eligible = self._cards(eligible_only=True)
        all_cards = self._cards()
        before = self._edge_snapshot(self.tools.relation_edges(list(all_cards.values())))
        after = mutate([dict(edge) for edge in before], eligible)
        after = self._edge_snapshot(after)
        with self.store._connect(self.project_id) as conn:
            self._write_edges(after, conn=conn)
            self.store.remember_relation_labels(
                self.project_id, [edge.get("label", "") for edge in before + after], conn=conn)
            if relation_layouts:
                self.store.remember_relation_layouts(self.project_id, relation_layouts, conn=conn)
            self._push_action({"kind": "relation", "label": label, "before": before, "after": after}, conn=conn)
        self.memory.reset("知识卡片关联已修改，下次读取新的关联依据")
        return {"edges": after, "undo": self.undo_summary()}

    def create_relation(self, source_id: str, target_id: str, label: str,
                        valid_from_chapter_id: str = "", invalid_from_chapter_id: str = "",
                        layout_mode: str = "") -> dict:
        source_id, target_id, label = str(source_id), str(target_id), str(label or "").strip()
        valid_from, invalid_from = self.tools._validate_relation_period(
            valid_from_chapter_id, invalid_from_chapter_id)
        def mutate(edges, eligible):
            if source_id not in eligible or target_id not in eligible or source_id == target_id:
                raise ValueError("只能关联当前有效且已确认的两张不同知识卡片")
            if any({edge["source_id"], edge["target_id"]} == {source_id, target_id} for edge in edges):
                raise ValueError("这两张卡片已经存在关联")
            edges.append({"id": "kr_" + uuid4().hex[:24], "source_id": source_id,
                          "target_id": target_id, "label": label,
                          "valid_from_chapter_id": valid_from,
                          "invalid_from_chapter_id": invalid_from})
            return edges
        return self._mutate_edges(mutate, "建立卡片关联", {label: layout_mode} if layout_mode else None)

    def update_relation(self, relation_id: str, source_id: str, target_id: str, label: str,
                        valid_from_chapter_id: str = "", invalid_from_chapter_id: str = "",
                        layout_mode: str = "") -> dict:
        relation_id, source_id, target_id, label = map(str, (relation_id, source_id, target_id, label or ""))
        label = label.strip()
        valid_from, invalid_from = self.tools._validate_relation_period(
            valid_from_chapter_id, invalid_from_chapter_id)
        def mutate(edges, eligible):
            index = next((i for i, edge in enumerate(edges) if edge["id"] == relation_id), -1)
            if index < 0:
                raise ValueError("关系已改变或不存在，请刷新画布")
            if source_id not in eligible or target_id not in eligible or source_id == target_id:
                raise ValueError("只能关联当前有效且已确认的两张不同知识卡片")
            if any(i != index and {edge["source_id"], edge["target_id"]} == {source_id, target_id}
                   for i, edge in enumerate(edges)):
                raise ValueError("这两张卡片已经存在关联")
            edges[index] = {"id": relation_id, "source_id": source_id, "target_id": target_id, "label": label,
                            "valid_from_chapter_id": valid_from,
                            "invalid_from_chapter_id": invalid_from}
            return edges
        return self._mutate_edges(mutate, "修改卡片关联", {label: layout_mode} if layout_mode else None)

    def delete_relation(self, relation_id: str) -> dict:
        relation_id = str(relation_id)
        def mutate(edges, _eligible):
            remaining = [edge for edge in edges if edge["id"] != relation_id]
            if len(remaining) == len(edges):
                raise ValueError("关系已改变或不存在，请刷新画布")
            return remaining
        return self._mutate_edges(mutate, "删除卡片关联")

    def record_merge(self, proposal: dict, merged: dict) -> None:
        source_ids = list(proposal.get("item_ids") or [])
        with self.store._connect(self.project_id) as conn:
            layout = self.layout(conn=conn)
            positions = layout["positions"]
            source_positions = {item_id: positions.get(item_id) for item_id in source_ids}
            points = [point for point in source_positions.values() if isinstance(point, dict)]
            if points:
                merged_position = {"x": round(sum(point["x"] for point in points) / len(points), 3),
                                   "y": round(sum(point["y"] for point in points) / len(points), 3)}
            else:
                merged_position = {"x": 0.0, "y": 0.0}
            positions[merged["id"]] = merged_position
            layout["updated_at"] = time.time()
            self._write_document(conn, self.LAYOUT_ID, "graph_layout", layout)
            from .story_segments import StorySegments
            segment_snapshot = StorySegments(self.store, self.project_id).transfer_merge(
                conn, source_ids, merged["id"])
            self._push_action({"kind": "merge", "label": f"合并 {len(source_ids)} 张卡片",
                               "proposal_id": proposal["id"], "merged_id": merged["id"],
                               "source_positions": source_positions, "merged_position": merged_position,
                               "segment_snapshot": segment_snapshot}, conn=conn)

    def undo(self) -> dict:
        history = self.history()
        action = self._latest_action(history)
        if not action:
            raise ValueError("没有可以撤销的画布操作")
        kind = action.get("kind")
        if kind == "merge":
            self.tools.undo_merge(action.get("proposal_id", ""))
        with self.store._connect(self.project_id) as conn:
            history = self.history(conn=conn)
            current = next((item for item in history["actions"] if item.get("id") == action["id"]), None)
            if not current or current.get("status") != "applied":
                raise ValueError("撤销记录已改变，请刷新画布")
            if kind == "move":
                cards = self._cards()
                if any(item_id not in cards for item_id in action.get("after", {})):
                    raise ValueError("被移动的卡片已改变，不能安全撤销")
                layout = self.layout(conn=conn)
                if any(layout["positions"].get(item_id) != point for item_id, point in action.get("after", {}).items()):
                    raise ValueError("卡片位置已被后续操作改变，不能安全撤销")
                for item_id, point in action.get("before", {}).items():
                    if point is None: layout["positions"].pop(item_id, None)
                    else: layout["positions"][item_id] = point
                self._write_document(conn, self.LAYOUT_ID, "graph_layout", layout)
            elif kind == "relation":
                current_edges = self._edge_snapshot(self.tools.relation_edges(list(self._cards().values())))
                if current_edges != action.get("after"):
                    raise ValueError("卡片关系已被后续操作改变，不能安全撤销")
                self._write_edges(action.get("before") or [], conn=conn)
            elif kind == "merge":
                layout = self.layout(conn=conn)
                layout["positions"].pop(action.get("merged_id", ""), None)
                for item_id, point in (action.get("source_positions") or {}).items():
                    if point is not None: layout["positions"][item_id] = point
                self._write_document(conn, self.LAYOUT_ID, "graph_layout", layout)
                from .story_segments import StorySegments
                StorySegments(self.store, self.project_id).undo_merge(conn, action.get("segment_snapshot"))
            else:
                raise ValueError("撤销记录类型无效")
            current["status"] = "undone"; current["undone_at"] = time.time()
            self._write_document(conn, self.HISTORY_ID, "graph_history", history)
        if kind == "relation": self.memory.reset("用户已撤销知识卡片关联修改")
        return {"ok": True, "kind": kind, "undone": action.get("label", "上一步操作"),
                "undo": self.undo_summary()}
