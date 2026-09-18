"""伏笔与剧情的引用、状态时间线和可恢复的检查建议。"""
from __future__ import annotations

import json
import copy
import time
from contextlib import contextmanager
from uuid import uuid4

STATUSES = {"unknown", "open", "partial", "resolved"}
ROLES = {"plant", "advance", "resolve"}
DOCUMENT_ID = "clue_plot_workspace_v1"


class ClueStore:
    def __init__(self, store, project_id):
        self.store, self.project_id = store, project_id

    @contextmanager
    def edit(self):
        with self.store._connect(self.project_id) as conn:
            conn.execute("BEGIN IMMEDIATE")
            data = self.read(conn)
            yield data
            conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                         "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                         (DOCUMENT_ID, "clue_workspace", json.dumps(data, ensure_ascii=False)))

    def read(self, conn=None):
        if conn is None:
            with self.store._connect(self.project_id) as db:
                return self.read(db)
        row = conn.execute("SELECT data FROM knowledge_workspace_state WHERE id=?", (DOCUMENT_ID,)).fetchone()
        return json.loads(row[0]) if row else {"links": [], "events": [], "suggestions": [], "jobs": []}

    @staticmethod
    def write(conn, data):
        conn.execute("INSERT INTO knowledge_workspace_state(id,kind,data) VALUES(?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                     (DOCUMENT_ID, "clue_workspace", json.dumps(data, ensure_ascii=False)))

    def transfer_merge(self, conn, source_ids, merged_id, kind):
        """原记录保留供历史和撤销使用；合并结果继承引用，不丢失人工对应。"""
        data = self.read(conn)
        if kind != "clue":
            if any(r["clue_id"] in source_ids for key in ("links", "events") for r in data[key]):
                raise ValueError("这些伏笔已有剧情关联或状态记录，请保持合并结果为伏笔类型")
            return None
        snapshot = {"merged_id": merged_id, "rows": {}}
        link_map = {}
        for key in ("links", "events", "suggestions"):
            rows = []
            for row in data[key]:
                if row["clue_id"] not in source_ids:
                    continue
                entry = copy.deepcopy(row)
                entry.update(id="cm_" + uuid4().hex, clue_id=merged_id, merged_from_clue=row["clue_id"])
                if key == "links":
                    duplicate = next((x for x in rows if x["plot_id"] == entry["plot_id"] and not x.get("removed") and not entry.get("removed")), None)
                    if duplicate:
                        link_map[row["id"]] = duplicate["id"]
                        continue
                    link_map[row["id"]] = entry["id"]
                elif key == "events" and entry.get("link_id"):
                    entry["link_id"] = link_map.get(entry["link_id"], entry["link_id"])
                    for field in ("link_before", "link_after"):
                        if entry.get(field):
                            entry[field].update(id=entry["link_id"], clue_id=merged_id, merged_from_clue=row["clue_id"])
                    if entry.get("link_changes"):
                        for change in entry["link_changes"]:
                            change["id"] = link_map.get(change["id"], change["id"])
                            for field in ("before", "after"):
                                if change.get(field):
                                    change[field].update(id=change["id"], clue_id=merged_id,
                                                         merged_from_clue=row["clue_id"])
                rows.append(entry)
            snapshot["rows"][key] = copy.deepcopy(rows)
            data[key].extend(rows)
        self.write(conn, data)
        return snapshot

    def undo_merge(self, conn, snapshot):
        if not snapshot:
            return
        data = self.read(conn)
        for key, before in snapshot["rows"].items():
            current = [r for r in data[key] if r["clue_id"] == snapshot["merged_id"]]
            if current != before:
                raise ValueError("合并后的伏笔关联或状态已修改，不能安全撤销合并；请先处理后续操作")
        for key in snapshot["rows"]:
            data[key] = [r for r in data[key] if r["clue_id"] != snapshot["merged_id"]]
        self.write(conn, data)

    def items(self):
        return {x["id"]: x for x in self.store.list_knowledge(self.project_id)}

    @staticmethod
    def require(items, item_id, kind):
        item = items.get(item_id)
        if not item or item["type"] != kind:
            raise ValueError("所选伏笔或剧情已失效，请刷新后重新选择")
        return item

    def project(self, items, max_order=None, *, proactive=False):
        """只把当前章节以前、来源仍有效的状态送给模型，历史不混入向量正文。"""
        data = self.read()
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        result = []
        for item in items:
            if item.get("type") != "clue":
                result.append(item)
                continue
            events = [e for e in data["events"] if e["clue_id"] == item["id"] and not e.get("undone")
                      and e["chapter_id"] in chapters
                      and chapters[e["chapter_id"]]["version"] == e["chapter_version"]
                      and all(chapters.get(cid, {}).get("version") == version for cid, version in e.get("evidence_versions", {}).items())
                      and (max_order is None or chapters[e["chapter_id"]]["position"] <= max_order)]
            events.sort(key=lambda e: (chapters[e["chapter_id"]]["position"], e["created_at"]))
            state = {"status": "unknown", "explanation": ""}
            if events:
                state = {k: events[-1].get(k) for k in
                         ("status", "explanation", "chapter_id", "source_quotes", "plot_id", "plot_ids")}
                state["plot_ids"] = list(events[-1].get("plot_ids") or
                                         ([events[-1].get("plot_id")] if events[-1].get("plot_id") else []))
            if proactive and state["status"] == "resolved":
                continue
            result.append({**item, "clue_state": state})
        # 查询剧情时同时返回关联伏笔；不把后文才出现的伏笔或回收说明带到早期分析。
        plot_ids = {i["id"] for i in result if i.get("type") == "plot"}
        if plot_ids:
            clue_ids = {l["clue_id"] for l in data["links"] if l["plot_id"] in plot_ids and not l.get("removed")}
            candidates = [c for c in self.store.list_knowledge(self.project_id, max_order=max_order)
                          if c["id"] in clue_ids and c["type"] == "clue"
                          and (max_order is None or c["order_end"] <= max_order)]
            projected = {c["id"]: c for c in self.project(candidates, max_order, proactive=proactive)}
            result = [{**i, "linked_clues": [{"id": c["id"], "title": c["title"], "summary": c["summary"],
                        "role": l["role"], "source_quotes": c["source_quotes"], "source_chapter_ids": c["source_chapter_ids"],
                        "clue_state": c["clue_state"]} for l in data["links"]
                        if l["plot_id"] == i["id"] and not l.get("removed") and l["clue_id"] in projected
                        for c in [projected[l["clue_id"]]]]} if i.get("type") == "plot" else i for i in result]
        return result

    @staticmethod
    def spans(item, chapters):
        # 只用真实连续原文确定自动关联；缺失的定位不能成为合并/编辑的阻断条件。
        found = []
        for quote in item.get("source_quotes") or []:
            if not isinstance(quote, str) or len(quote.strip()) < 8:
                continue
            for cid, chapter in chapters.items():
                start = 0
                while (pos := chapter["text"].find(quote, start)) >= 0:
                    found.append((cid, pos, pos + len(quote)))
                    start = pos + len(quote)
        return found

    def candidates(self, clue, plots, chapters, plot_spans=None):
        spans = self.spans(clue, chapters)
        chapter_ids = {s[0] for s in spans} or set(clue.get("source_chapter_ids") or [])
        result = []
        for plot in plots:
            other = plot_spans[plot["id"]] if plot_spans is not None else self.spans(plot, chapters)
            overlap = any(a == b and max(x, u) < min(y, v)
                          for a, x, y in spans for b, u, v in other)
            shared = chapter_ids & ({s[0] for s in other} or set(plot.get("source_chapter_ids") or []))
            if overlap or shared:
                result.append({"plot_id": plot["id"], "title": plot["title"], "summary": plot["summary"],
                               "exact": overlap, "chapter_ids": sorted(shared)})
        return sorted(result, key=lambda r: not r["exact"])

    def overview(self):
        items = self.items()
        data = self.read()
        clues = self.project([i for i in items.values() if i["type"] == "clue"])
        plots = [i for i in items.values() if i["type"] == "plot"]
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        from .knowledge_tools import KnowledgeTools
        edges = KnowledgeTools(self.store, self.project_id).relation_edges(list(items.values()))
        plot_spans = {p["id"]: self.spans(p, chapters) for p in plots}
        links = []
        for link in data["links"]:
            if link.get("removed") or link["clue_id"] not in items:
                continue
            valid = items.get(link["plot_id"], {}).get("type") == "plot"
            links.append({**link, "stale": not valid})
        suggestions = [s for s in data["suggestions"] if s.get("decision") == "pending" and items.get(s["clue_id"], {}).get("type") == "clue"]
        for clue in clues:
            clue["cross_references"] = [{"id": other, "title": items[other]["title"], "label": edge["label"]}
                                        for edge in edges
                                        if clue["id"] in (edge["source_id"], edge["target_id"])
                                        for other in [edge["target_id"] if edge["source_id"] == clue["id"] else edge["source_id"]]
                                        if other in items]
            clue["candidates"] = self.candidates(clue, plots, chapters, plot_spans)
            clue["can_undo_state"] = any(e["clue_id"] == clue["id"] and not e.get("undone") for e in data["events"])
            clue["state_history"] = [{k: e.get(k) for k in ("id", "status", "chapter_id", "explanation", "source_quotes", "plot_id", "plot_ids", "undone")}
                                     for e in data["events"] if e["clue_id"] == clue["id"]]
        return {"clues": clues, "links": links, "suggestions": suggestions,
                "jobs": data["jobs"][-5:], "chapters": [{k: c[k] for k in ("id", "title", "position")} for c in chapters.values()]}

    def match(self, new_ids=None):
        items = self.items()
        plots = [i for i in items.values() if i["type"] == "plot"]
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        plot_spans = {p["id"]: self.spans(p, chapters) for p in plots}
        matches = {i["id"]: self.candidates(i, plots, chapters, plot_spans) for i in items.values() if i["type"] == "clue"}
        added = 0
        with self.edit() as data:
            for clue_id, candidates in matches.items():
                exact = [c for c in candidates if c["exact"]]
                if len(exact) != 1:
                    continue
                plot_id = exact[0]["plot_id"]
                if new_ids is not None and clue_id not in new_ids and plot_id not in new_ids:
                    continue
                # 人工解绑留下 tombstone；旧事件失效的关联只提示重选，不静默替换。
                if any(l["clue_id"] == clue_id for l in data["links"]):
                    continue
                data["links"].append({"id": "cp_" + uuid4().hex, "clue_id": clue_id, "plot_id": plot_id,
                                      "role": "plant", "origin": "auto", "confirmed": False})
                added += 1
        return {"added": added}

    def link(self, clue_id, plot_id, role, link_id=""):
        items = self.items()
        self.require(items, clue_id, "clue"); self.require(items, plot_id, "plot")
        if role not in ROLES:
            raise ValueError("关联类型必须是埋下、推进或回收")
        with self.edit() as data:
            existing = next((l for l in data["links"] if l["id"] == link_id), None) if link_id else next(
                (l for l in data["links"] if l["clue_id"] == clue_id and l["plot_id"] == plot_id and not l.get("removed")), None)
            if link_id and (not existing or existing["clue_id"] != clue_id):
                raise ValueError("原关联不存在")
            if existing:
                if any(l is not existing and not l.get("removed") and l["clue_id"] == clue_id and l["plot_id"] == plot_id for l in data["links"]):
                    raise ValueError("这条剧情已经关联，请编辑已有关系")
                existing.update(plot_id=plot_id, role=role, origin="manual", confirmed=True, removed=False)
                return existing
            result = {"id": "cp_" + uuid4().hex, "clue_id": clue_id, "plot_id": plot_id,
                      "role": role, "origin": "manual", "confirmed": True}
            data["links"].append(result)
            return result

    def unlink(self, link_id):
        with self.edit() as data:
            link = next((l for l in data["links"] if l["id"] == link_id), None)
            if not link:
                raise ValueError("关联不存在")
            link["removed"] = True

    def set_state(self, clue_id, status, chapter_id, explanation="", source_quotes=None,
                  plot_id="", plot_ids=None, suggestion_id=""):
        items = self.items()
        self.require(items, clue_id, "clue")
        chapters = {c["id"]: c for c in self.store.list_chapters(self.project_id)}
        if status not in STATUSES or chapter_id not in chapters:
            raise ValueError("请选择状态和生效章节")
        if status in {"partial", "resolved"} and not explanation.strip():
            raise ValueError("请填写部分回收或填坑的解释")
        if len(explanation) > 4000:
            raise ValueError("说明不能超过4000字")
        selected_plot_ids = list(dict.fromkeys(
            value for value in ([plot_id] + list(plot_ids or [])) if value))
        if len(selected_plot_ids) > 50:
            raise ValueError("一次最多关联50条剧情")
        for selected_plot_id in selected_plot_ids:
            plot = self.require(items, selected_plot_id, "plot")
            if plot.get("order_end", plot.get("order_start", 0)) > chapters[chapter_id]["position"]:
                raise ValueError("生效章节不能早于对应剧情事件")
        with self.edit() as data:
            if suggestion_id:
                suggestion = next((s for s in data["suggestions"] if s["id"] == suggestion_id and s["clue_id"] == clue_id), None)
                if not suggestion or suggestion["decision"] != "pending":
                    raise ValueError("建议已处理，请刷新")
                if any(chapters.get(cid, {}).get("version") != version for cid, version in suggestion["versions"].items()):
                    raise ValueError("建议依据的正文已改变，请重新检查")
                if any(chapters[cid]["position"] > chapters[chapter_id]["position"] for cid in suggestion["versions"]):
                    raise ValueError("生效章节不能早于建议的原文依据")
                suggestion["decision"] = "accepted"
            link_changes = []
            for selected_plot_id in selected_plot_ids:
                link = next((l for l in data["links"] if l["clue_id"] == clue_id and l["plot_id"] == selected_plot_id and not l.get("removed")), None)
                link_before = copy.deepcopy(link) if link else None
                if not link:
                    link = {"id": "cp_" + uuid4().hex, "clue_id": clue_id,
                            "plot_id": selected_plot_id,
                            "role": "resolve" if status == "resolved" else "advance"}
                    data["links"].append(link)
                # Selecting an already-linked planting/progress event as supporting
                # context must not silently rewrite its semantic role.
                link.update(origin="manual", confirmed=True)
                link_changes.append({"id": link["id"], "before": link_before,
                                     "after": copy.deepcopy(link)})
            first_change = link_changes[0] if link_changes else None
            event = {"id": "cs_" + uuid4().hex, "clue_id": clue_id, "status": status,
                     "chapter_id": chapter_id, "chapter_version": chapters[chapter_id]["version"],
                     "explanation": explanation.strip(), "source_quotes": source_quotes or [],
                     "plot_id": selected_plot_ids[0] if selected_plot_ids else "",
                     "plot_ids": selected_plot_ids, "created_at": time.time(),
                     "link_changes": link_changes,
                     "link_id": first_change["id"] if first_change else "",
                     "link_before": first_change["before"] if first_change else None,
                     "link_after": first_change["after"] if first_change else None}
            data["events"].append(event)
            evidence_versions = dict(suggestion["versions"] if suggestion_id else {})
            evidence_versions[chapter_id] = chapters[chapter_id]["version"]
            # User-entered evidence remains allowed, but every quote we can locate is
            # version-tracked so later edits invalidate an obsolete state snapshot.
            from .knowledge_tools import KnowledgeTools
            eligible = sorted((c for c in chapters.values()
                               if c["position"] <= chapters[chapter_id]["position"]),
                              key=lambda c: -c["position"])
            for quote in source_quotes or []:
                located = next((c for c in eligible
                                if KnowledgeTools._locate_source_quote(quote, c.get("text") or "")), None)
                if located:
                    evidence_versions[located["id"]] = located["version"]
            event["evidence_versions"] = evidence_versions
            return event

    def undo_state(self, clue_id):
        self.require(self.items(), clue_id, "clue")
        with self.edit() as data:
            event = next((e for e in reversed(data["events"]) if e["clue_id"] == clue_id and not e.get("undone")), None)
            if not event:
                raise ValueError("没有可以撤销的状态确认")
            if event.get("link_changes"):
                resolved = []
                for change in event["link_changes"]:
                    link = next((l for l in data["links"] if l["id"] == change["id"]), None)
                    if link != change["after"]:
                        raise ValueError("对应关系随后已修改，请先处理关系修改")
                    resolved.append((link, change))
                for link, change in resolved:
                    if change["before"]:
                        link.clear(); link.update(change["before"])
                    else:
                        link["removed"] = True
            elif event.get("link_id"):
                link = next((l for l in data["links"] if l["id"] == event["link_id"]), None)
                if link != event["link_after"]:
                    raise ValueError("对应关系随后已修改，请先处理关系修改")
                if event["link_before"]:
                    link.clear(); link.update(event["link_before"])
                else:
                    link["removed"] = True
            event["undone"] = True

    def suggest(self, updates, chapters):
        if not isinstance(updates, list):
            return
        from .knowledge_tools import KnowledgeTools
        items = self.items()
        collected = []
        for raw in updates[:50]:
            if not isinstance(raw, dict) or items.get(raw.get("clue_id"), {}).get("type") != "clue":
                continue
            if raw.get("status") not in STATUSES or not str(raw.get("explanation") or "").strip():
                continue
            evidence = []
            for quote in (raw.get("source_quotes") or [])[:5]:
                for chapter in chapters:
                    exact = KnowledgeTools._locate_source_quote(str(quote), chapter["text"])
                    if exact:
                        evidence.append((chapter, exact)); break
            if not evidence:
                continue
            chapter = max((c for c, _ in evidence), key=lambda c: c["position"])
            plot_id = raw.get("plot_id", "")
            if items.get(plot_id, {}).get("type") != "plot":
                plot_id = ""
            collected.append({"id": "cu_" + uuid4().hex, "clue_id": raw["clue_id"], "status": raw["status"],
                              "explanation": str(raw["explanation"])[:4000], "chapter_id": chapter["id"],
                              "source_quotes": list(dict.fromkeys(q for _, q in evidence)), "plot_id": plot_id,
                              "versions": {c["id"]: c["version"] for c, _ in evidence}, "decision": "pending"})
        with self.edit() as data:
            for entry in collected:
                if not any(all(s.get(k) == entry.get(k) for k in ("clue_id", "status", "source_quotes")) for s in data["suggestions"]):
                    data["suggestions"].append(entry)

    def dismiss(self, suggestion_id):
        with self.edit() as data:
            for suggestion in data["suggestions"]:
                if suggestion["id"] == suggestion_id:
                    suggestion["decision"] = "ignored"
                    return
            raise ValueError("建议不存在")

    def save_job(self, job):
        with self.edit() as data:
            data["jobs"] = [j for j in data["jobs"] if j["id"] != job["id"]] + [job]
