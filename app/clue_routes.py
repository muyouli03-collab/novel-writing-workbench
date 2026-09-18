"""伏笔操作和可恢复的后台检查。"""
import asyncio
import json
from uuid import uuid4
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from .clues import ClueStore, STATUSES
from .knowledge_memory import compact_knowledge
from .knowledge_tools import KnowledgeTools
from .projects import group_complete_chapters
from .prompts import render_prompt

router = APIRouter(prefix="/api/projects/{project_id}/knowledge/clues")


def service(project_id):
    from . import main
    if not main._projects.get(project_id):
        raise HTTPException(404, "创作项目不存在")
    return ClueStore(main._projects, project_id)


def change(call):
    try:
        return call()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


class LinkBody(BaseModel):
    clue_id: str
    plot_id: str
    role: str = "plant"


class StateBody(BaseModel):
    status: str
    chapter_id: str
    explanation: str = ""
    source_quotes: list[str] = Field(default_factory=list)
    plot_id: str = ""
    plot_ids: list[str] = Field(default_factory=list, max_length=50)
    suggestion_id: str = ""


class StateAutofillBody(BaseModel):
    status: str
    chapter_id: str
    plot_ids: list[str] = Field(default_factory=list, max_length=50)
    current_explanation: str = Field(default="", max_length=4000)
    current_source_quotes: list[str] = Field(default_factory=list, max_length=8)


class CheckBody(BaseModel):
    chapter_ids: list[str] = Field(default_factory=list)
    job_id: str = ""


@router.get("")
def overview(project_id: str):
    from . import main
    result = service(project_id).overview()
    result["active_task_id"] = main._project_knowledge_tool_tasks.get(project_id, "") if any(
        j.get("task_id") == main._project_knowledge_tool_tasks.get(project_id) for j in result["jobs"]) else ""
    result["state_autofill_supported"] = True
    return result


@router.post("/match")
def match(project_id: str):
    return change(lambda: service(project_id).match())


@router.post("/links")
def create_link(project_id: str, body: LinkBody):
    return change(lambda: service(project_id).link(**body.model_dump()))


@router.put("/links/{link_id}")
def update_link(project_id: str, link_id: str, body: LinkBody):
    return change(lambda: service(project_id).link(**body.model_dump(), link_id=link_id))


@router.delete("/links/{link_id}")
def delete_link(project_id: str, link_id: str):
    change(lambda: service(project_id).unlink(link_id))
    return {"ok": True}


@router.post("/{clue_id}/state")
def set_state(project_id: str, clue_id: str, body: StateBody):
    tool = service(project_id)
    result = change(lambda: tool.set_state(clue_id, **body.model_dump()))
    from .knowledge_memory import KnowledgeMemory
    memory = KnowledgeMemory(tool.store, project_id)
    memory.reset("伏笔状态已更新，下次读取按章节计算的新状态")
    memory.reset_reading_session("伏笔状态已更新")
    return result


@router.post("/{clue_id}/state/autofill")
async def autofill_state(project_id: str, clue_id: str, body: StateAutofillBody):
    """Draft, but never save, a clue-state explanation and exact evidence."""
    from . import main
    from .llm import (clue_progress_autofill_call, clue_progress_autofill_messages,
                      knowledge_lookup_scope)

    tool = service(project_id)
    items = tool.items()
    clue = change(lambda: tool.require(items, clue_id, "clue"))
    chapters = {chapter["id"]: chapter for chapter in tool.store.list_chapters(project_id)}
    chapter = chapters.get(body.chapter_id)
    if body.status not in STATUSES or not chapter:
        raise HTTPException(400, "请先选择状态和生效章节")
    boundary = chapter["position"]
    if clue.get("order_start", 0) > boundary:
        raise HTTPException(400, "生效章节不能早于伏笔首次出现的章节")
    plot_ids = list(dict.fromkeys(value for value in body.plot_ids if value))
    existing_roles = {link["plot_id"]: link.get("role", "") for link in tool.read()["links"]
                      if link.get("clue_id") == clue_id and not link.get("removed")}
    selected_plots = []
    for plot_id in plot_ids:
        plot = items.get(plot_id)
        if not plot or plot.get("type") != "plot":
            raise HTTPException(409, "所选剧情已失效，请刷新后重新选择")
        if plot.get("order_end", plot.get("order_start", 0)) > boundary:
            raise HTTPException(400, "生效章节不能早于所选剧情事件")
        selected = compact_knowledge(plot)
        selected["clue_role"] = existing_roles.get(plot_id, "")
        selected_plots.append(selected)

    projected = tool.project([clue], boundary)[0]
    clue_context = compact_knowledge(projected)
    clue_context["clue_state"] = projected.get("clue_state", {})
    chapter_context = {key: chapter.get(key) for key in ("id", "title", "position", "text")}
    current_draft = {"explanation": body.current_explanation,
                     "source_quotes": body.current_source_quotes}
    messages = clue_progress_autofill_messages(
        clue_context, body.status, chapter_context, projected.get("clue_state", {}),
        selected_plots, current_draft)
    request_messages = json.loads(json.dumps(messages, ensure_ascii=False))
    trace: list[dict] = []
    run_id = "kr_" + uuid4().hex
    main._projects.create_ai_run(
        project_id, run_id, "knowledge_build", f"AI填充伏笔进展：{clue['title']}",
        {"operation": "clue_state_autofill", "clue_id": clue_id,
         "chapter_id": chapter["id"], "plot_ids": plot_ids},
    )
    main._knowledge_run_event(
        project_id, run_id, "request", "发送伏笔进展填充请求",
        f"生效章节：{chapter['title']}；选择 {len(plot_ids)} 条对应剧情",
        {"messages": request_messages},
    )

    async def lookup_knowledge(query: str, top_k: int) -> list[dict]:
        found, _ = await main._search_knowledge_cards_for_build(
            project_id, query, boundary, top_k)
        return found

    async def lookup_source(query: str, top_k: int) -> list[dict]:
        return await main._search_project_source(project_id, query, boundary, top_k)

    usage = {}
    try:
        with knowledge_lookup_scope(lookup_knowledge, trace, lookup_source,
                                    max_calls=2, max_rounds=2):
            parsed, raw = await asyncio.wait_for(
                main._wrap_llm(clue_progress_autofill_call(
                    clue_context, body.status, chapter_context, projected.get("clue_state", {}),
                    selected_plots, current_draft, messages=messages, usage_out=usage)),
                timeout=150,
            )
        explanation = str(parsed.get("explanation") or "").strip()[:4000]
        if not explanation:
            raise ValueError("模型没有生成可用的伏笔进展解释")
        raw_quotes = parsed.get("source_quotes")
        if not isinstance(raw_quotes, list):
            raw_quotes = []
        eligible = sorted(
            (value for value in chapters.values() if value["position"] <= boundary),
            key=lambda value: (value["id"] != chapter["id"], -value["position"]),
        )
        quotes, evidence_chapters, discarded = [], [], 0
        for value in raw_quotes[:8]:
            candidate = str(value or "").strip()[:800]
            located = next(((source, exact) for source in eligible
                            if (exact := KnowledgeTools._locate_source_quote(
                                candidate, source.get("text") or ""))), None)
            if not located:
                discarded += 1
                continue
            source, exact = located
            if exact not in quotes:
                quotes.append(exact)
            if source["id"] not in evidence_chapters:
                evidence_chapters.append(source["id"])
        main._knowledge_run_event(
            project_id, run_id, "response", "分析模型返回填充草稿",
            f"生成解释和 {len(raw_quotes)} 段候选依据；调用本作查询工具 {len(trace)} 次",
            {"raw": raw, "usage": usage, "tool_calls": trace,
             "messages": messages[len(request_messages):]},
        )
        main._knowledge_run_event(
            project_id, run_id, "validation", "程序逐字核对正文依据",
            f"保留 {len(quotes)} 段，丢弃 {discarded} 段无法定位的内容",
            {"accepted_quotes": quotes, "discarded_count": discarded,
             "evidence_chapter_ids": evidence_chapters},
        )
        main._projects.finish_ai_run(project_id, run_id, "done", "草稿已填入表单，尚未保存")
        chapter_names = {value["id"]: value["title"] for value in chapters.values()}
        return {
            "explanation": explanation, "source_quotes": quotes,
            "evidence_note": str(parsed.get("evidence_note") or "")[:500],
            "evidence_chapters": [{"id": cid, "title": chapter_names[cid]}
                                  for cid in evidence_chapters],
            "discarded_quotes": discarded, "tool_calls": trace,
            "run_id": run_id, "saved": False,
        }
    except ValueError as exc:
        main._knowledge_run_event(project_id, run_id, "error", "AI填充结果不可用", str(exc))
        main._projects.finish_ai_run(project_id, run_id, "error", str(exc))
        raise HTTPException(502, str(exc)) from exc
    except asyncio.TimeoutError as exc:
        message = "AI填充超过150秒，已停止本次请求；原表单内容没有改变，请稍后重试"
        main._knowledge_run_event(project_id, run_id, "error", "AI填充超时", message)
        main._projects.finish_ai_run(project_id, run_id, "error", message)
        raise HTTPException(504, message) from exc
    except Exception as exc:
        main._knowledge_run_event(project_id, run_id, "error", "AI填充失败", str(getattr(exc, "detail", exc)))
        main._projects.finish_ai_run(project_id, run_id, "error", str(getattr(exc, "detail", exc)))
        raise


@router.post("/{clue_id}/undo")
def undo_state(project_id: str, clue_id: str):
    change(lambda: service(project_id).undo_state(clue_id))
    from .knowledge_memory import KnowledgeMemory
    tool = service(project_id)
    KnowledgeMemory(tool.store, project_id).reset("已撤销伏笔状态确认")
    KnowledgeMemory(tool.store, project_id).reset_reading_session("已撤销伏笔状态确认")
    return {"ok": True}


@router.post("/suggestions/{suggestion_id}/dismiss")
def dismiss(project_id: str, suggestion_id: str):
    change(lambda: service(project_id).dismiss(suggestion_id))
    return {"ok": True}


@router.post("/check")
async def check(project_id: str, body: CheckBody):
    from . import main
    from .llm import draft_analysis_call
    tool = service(project_id)
    main._knowledge_memory_available(project_id)
    chapters = {c["id"]: c for c in tool.store.list_chapters(project_id)}
    if body.job_id:
        job = next((j for j in tool.read()["jobs"] if j["id"] == body.job_id), None)
        if not job or job["status"] == "done":
            raise HTTPException(409, "没有可继续的检查")
        if any(chapters.get(cid, {}).get("version") != version for cid, version in job["versions"].items()):
            raise HTTPException(409, "正文已改变，请重新选择章节检查")
    else:
        ids = set(body.chapter_ids)
        if not ids or ids - chapters.keys():
            raise HTTPException(400, "请勾选需要检查的有效章节")
        chosen = sorted((chapters[cid] for cid in ids), key=lambda c: c["position"])
        limit = main.settings.knowledge_chapter_char_limit()
        groups = change(lambda: group_complete_chapters(chosen, limit, limit))
        job = {"id": "cj_" + uuid4().hex, "groups": [[c["id"] for c in g] for g in groups],
               "versions": {c["id"]: c["version"] for c in chosen}, "next_group": 0, "status": "running"}
    task_id = uuid4().hex
    job.update(status="running", task_id=task_id, error="")
    tool.save_job(job)
    main._project_knowledge_tool_tasks[project_id] = task_id
    main._progress_start(task_id, {"status": "running", "done": job["next_group"], "total": len(job["groups"]),
                                   "kind": "clue_check", "message": "正在检查伏笔进展"})

    async def run():
        try:
            for index in range(job["next_group"], len(job["groups"])):
                if main._progress[task_id].get("cancel_requested"):
                    break
                group = [tool.store.get_chapter(project_id, cid) for cid in job["groups"][index]]
                if any(not c or c["version"] != job["versions"][c["id"]] for c in group):
                    raise ValueError("所选正文已改变，请重新检查")
                boundary = max(c["position"] for c in group)
                all_items = [i for i in tool.store.list_knowledge(project_id, max_order=boundary) if i["order_end"] <= boundary]
                clues = tool.project([c for c in all_items if c["type"] == "clue"], boundary)
                for offset in range(0, max(1, len(clues)), 20):
                    evidence = [{**compact_knowledge(c), "clue_state": c["clue_state"]} for c in clues[offset:offset + 20]]
                    plots = [compact_knowledge(p) for p in all_items if p["type"] == "plot" and set(p["source_chapter_ids"]) & set(job["groups"][index])]
                    parsed, _ = await main._wrap_llm(draft_analysis_call([
                        {"role": "system", "content": render_prompt("clue_progress.instructions")},
                        {"role": "user", "content": render_prompt("clue_progress.check", clues=json.dumps(evidence, ensure_ascii=False),
                            plots=json.dumps(plots, ensure_ascii=False), chapters=json.dumps(group, ensure_ascii=False))},
                    ]))
                    current = {c["id"]: c for c in tool.store.list_chapters(project_id)}
                    if any(current.get(c["id"], {}).get("version") != c["version"] for c in group):
                        raise ValueError("生成期间正文已改变，请重新检查")
                    tool.suggest(parsed.get("clue_updates", []), group)
                job["next_group"] = index + 1
                tool.save_job(job)
                main._progress_update(task_id, {"done": index + 1, "message": f"已检查 {index + 1}/{len(job['groups'])} 批"})
            job["status"] = "done" if job["next_group"] == len(job["groups"]) else "paused"
            tool.save_job(job)
            main._progress_update(task_id, {"status": "done", "message": "伏笔建议已保存，请逐条确认", "result": {"job_id": job["id"]}})
        except Exception as exc:
            job.update(status="error", error=str(getattr(exc, "detail", exc)))
            tool.save_job(job)
            main._progress_update(task_id, {"status": "error", "error": job["error"]})
        finally:
            main._project_knowledge_tool_tasks.pop(project_id, None)
    main._spawn(run())
    return {"task_id": task_id, "job_id": job["id"]}


@router.post("/check/stop")
def stop(project_id: str):
    from . import main
    service(project_id)
    task_id = main._project_knowledge_tool_tasks.get(project_id)
    if task_id and main._progress.get(task_id, {}).get("kind") == "clue_check":
        main._progress_update(task_id, {"cancel_requested": True})
    return {"ok": True}
