"""LLM 精读:HyDE 扩写检索 + 候选精选 + 技法拆解(DeepSeek / OpenAI 兼容)。"""
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import json
import re
from typing import Awaitable, Callable

import httpx

from .draft_text import draft_segments
from .net import is_local_url
from .settings import get as get_settings, resolve_llm
from .prompts import render_prompt
from .projects import required_plot_events


_KnowledgeLookup = Callable[[str, int], Awaitable[list[dict]]]
_SourceLookup = Callable[[str, int], Awaitable[list[dict]]]
_knowledge_lookup_runtime: ContextVar[dict | None] = ContextVar("knowledge_lookup_runtime", default=None)


@contextmanager
def knowledge_lookup_scope(callback: _KnowledgeLookup | None, trace: list[dict] | None = None,
                           source_callback: _SourceLookup | None = None, *,
                           max_calls: int = 4, max_rounds: int = 3):
    """Attach bounded project-scoped knowledge and original-text tools to a build task."""
    token = _knowledge_lookup_runtime.set({"callback": callback, "source_callback": source_callback,
                                           "trace": trace if trace is not None else [],
                                           "max_calls": min(max(int(max_calls), 0), 8),
                                           "max_rounds": min(max(int(max_rounds), 1), 4)})
    try:
        yield
    finally:
        _knowledge_lookup_runtime.reset(token)


_PROJECT_KNOWLEDGE_TOOLS = [{
    "type": "function",
    "function": {
        "name": "search_project_knowledge",
        "description": "查询当前任务允许范围内的本作已有知识卡片，用于理解不确定的专有名词、人物身份、关系、能力和世界规则。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "简短、具体的查询，例如：鬼电话 能力 限制"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 8, "description": "需要返回的结果数，默认5"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}, {
    "type": "function",
    "function": {
        "name": "search_project_source",
        "description": "检索本批章节之前的小说原文。涉及数量、先后顺序、具体动作、原话、人物是否知情或索引疑似冲突时，用它核对原始证据。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "用于原文检索的具体人名、名词、动作和同义表达"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 8, "description": "候选原文片段数，默认5"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}]

def draft_analysis_messages(draft: str, supplemental_info: str = "") -> list[dict]:
    """构建固定的原稿+补充信息前缀;后续只追加消息以提高上下文缓存命中。"""
    paragraphs = draft_segments(draft)
    numbered = "\n\n".join(f"[P{i}] {p['text']}" for i, p in enumerate(paragraphs, 1))
    task = (
        render_prompt('draft_analysis_messages.task', value_1=supplemental_info.strip() or "（未提供）", numbered=numbered)
    )
    return [
        {"role": "system", "content": render_prompt('shared.draft_system')},
        {"role": "user", "content": task},
    ]


def draft_clarification_request(answers: list[dict], correction: str = "") -> str:
    """追加用户回答,让分析模型更新理解并决定是否还需追问。"""
    return (
        render_prompt('draft_clarification_request.user', value_1=json.dumps(answers or [], ensure_ascii=False), value_2=correction.strip() or "（无）")
    )


def draft_decomposition_request() -> str:
    """理解经用户确认后,主动诊断薄弱描写并生成语境完整的检索单元。"""
    return (
        render_prompt('draft_decomposition_request.user', value_1=render_prompt('shared.query_rules'))
    )


def draft_unit_repair_request(raw_units: list[dict]) -> str:
    """上一轮漏字段或把原文当摘要时，在同一缓存会话中要求模型修复。"""
    compact = []
    for raw in (raw_units or [])[:8]:
        if not isinstance(raw, dict):
            continue
        compact.append({
            "id": str(raw.get("id") or "")[:40],
            "paragraph_start": raw.get("paragraph_start"),
            "paragraph_end": raw.get("paragraph_end"),
            "source_text": str(raw.get("source_text") or "")[:400],
            "weakness": str(raw.get("weakness") or "")[:300],
            "context_summary": str(raw.get("context_summary") or "")[:300],
            "enrichment_goal": str(raw.get("enrichment_goal") or raw.get("intent") or "")[:300],
            "query": str(raw.get("query") or "")[:300],
        })
    return (
        render_prompt('draft_unit_repair_request.user', value_1=json.dumps(compact, ensure_ascii=False))
    )


async def draft_analysis_call(messages: list[dict], *, usage_out: dict | None = None) -> tuple[dict, str]:
    """调用独立的原稿分析模型;未配置时复用主 LLM。"""
    s = get_settings()
    endpoint = resolve_llm("analysis", s)
    content = await _post(
        messages,
        temperature=0.2,
        json_mode=True,
        **endpoint,
        **({"usage_out": usage_out} if usage_out is not None else {}),
    )
    return _parse_analysis_json(content), content


def project_knowledge_messages(project: dict, chapters: list[dict], previous: list[dict] | None = None) -> list[dict]:
    """构造按完整章节提取项目知识的稳定提示。"""
    system = "\n\n".join([
        render_prompt('project_knowledge_messages.system'),
        render_prompt('project_character_state.instructions'),
        render_prompt('project_knowledge_tool.instructions'),
        render_prompt('clue_progress.instructions'),
    ])
    project_info = {
        key: project.get(key, "") for key in
        ("name", "concept", "characters", "worldbuilding", "style", "current_goal")
    }
    chapter_text = "\n\n".join(
        f"【{c.get('title') or '未命名章节'}｜chapter_id={c.get('id')}｜"
        f"最低剧情事件数={required_plot_events(c.get('text') or '')}】\n{c.get('text') or ''}"
        for c in chapters
    )
    prior = (previous or [])[-80:]
    user = (
        render_prompt('project_knowledge_messages.user', value_1=json.dumps(prior, ensure_ascii=False), chapter_text=chapter_text)
    )
    # 初始设定属于稳定前缀；新章节及相关知识只追加在末尾。
    system += (render_prompt('project_knowledge_messages.context', value_1=json.dumps(project_info, ensure_ascii=False)))
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def project_knowledge_call(project: dict, chapters: list[dict],
                                 previous: list[dict] | None = None, *,
                                 messages: list[dict] | None = None, usage_out: dict | None = None) -> tuple[dict, str]:
    active_messages = messages if messages is not None else project_knowledge_messages(project, chapters, previous)
    return await _project_scoped_analysis_call(active_messages, usage_out=usage_out)


async def _project_scoped_analysis_call(active_messages: list[dict], *,
                                        usage_out: dict | None = None) -> tuple[dict, str]:
    """Use the bounded project tools when the caller attached a lookup scope."""
    runtime = _knowledge_lookup_runtime.get()
    if not runtime or not (runtime.get("callback") or runtime.get("source_callback")):
        return await draft_analysis_call(active_messages, usage_out=usage_out)
    try:
        return await _project_knowledge_tool_loop(active_messages, runtime, usage_out)
    except httpx.HTTPStatusError as exc:
        # Some OpenAI-compatible local endpoints do not implement tool calling. Preserve
        # the old one-shot behavior instead of making knowledge building unusable.
        body = exc.response.text.casefold()
        unsupported = exc.response.status_code in {400, 404, 422} and any(
            marker in body for marker in ("tool", "function", "unsupported", "not support", "不支持")
        )
        if not unsupported:
            raise
        runtime["trace"].append({"status": "unavailable", "reason": "当前模型接口不支持工具调用"})
        fallback = list(active_messages) + [{
            "role": "user",
            "content": "本次模型接口不支持本作查询工具调用。请只依据当前已经提供的章节和历史知识完成整理；资料不足时明确写未知。",
        }]
        return await draft_analysis_call(fallback, usage_out=usage_out)


async def _project_knowledge_tool_loop(messages: list[dict], runtime: dict,
                                       usage_out: dict | None = None) -> tuple[dict, str]:
    """Run bounded native function calling while keeping tool turns in the build session."""
    callback: _KnowledgeLookup | None = runtime.get("callback")
    source_callback: _SourceLookup | None = runtime.get("source_callback")
    trace: list[dict] = runtime["trace"]
    calls_used = 0
    max_calls = int(runtime.get("max_calls", 4))
    max_rounds = int(runtime.get("max_rounds", 3))

    for _ in range(max_rounds):
        message = await _post_message(
            messages, temperature=0.2, json_mode=True,
            **resolve_llm("analysis", get_settings()), usage_out=usage_out,
            tools=[tool for tool in _PROJECT_KNOWLEDGE_TOOLS
                   if tool["function"]["name"] != "search_project_knowledge" or callback
                   if tool["function"]["name"] != "search_project_source" or source_callback],
            tool_choice="auto",
        )
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            content = message.get("content") or ""
            return _parse_analysis_json(content), content

        assistant_message = {"role": "assistant", "content": message.get("content"),
                             "tool_calls": tool_calls}
        if message.get("reasoning_content") is not None:
            assistant_message["reasoning_content"] = message["reasoning_content"]
        messages.append(assistant_message)
        for call in tool_calls:
            call_id = str(call.get("id") or f"knowledge_call_{calls_used + 1}")
            function = call.get("function") if isinstance(call, dict) else {}
            function = function if isinstance(function, dict) else {}
            name = str(function.get("name") or "")
            query, top_k, error = "", 5, ""
            try:
                raw_arguments = function.get("arguments") or "{}"
                arguments = raw_arguments if isinstance(raw_arguments, dict) else json.loads(raw_arguments)
                if not isinstance(arguments, dict):
                    raise ValueError("参数必须是JSON对象")
                query = str(arguments.get("query") or "").strip()[:300]
                top_k = min(max(int(arguments.get("top_k") or 5), 1), 8)
                if name not in {"search_project_knowledge", "search_project_source"}:
                    raise ValueError("未知工具")
                if name == "search_project_knowledge" and callback is None:
                    raise ValueError("本批没有可查询的旧知识")
                if name == "search_project_source" and source_callback is None:
                    raise ValueError("本批没有可查询的历史原文")
                if not query:
                    raise ValueError("查询内容不能为空")
                if calls_used >= max_calls:
                    raise ValueError("本批知识库查询次数已用完")
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                error = str(exc)

            if error:
                payload = {"ok": False, "error": error, "results": []}
            else:
                calls_used += 1
                try:
                    active_callback = source_callback if name == "search_project_source" else callback
                    results = await active_callback(query, top_k)
                    payload = {"ok": True, "query": query, "count": len(results), "results": results}
                    entry = {"status": "ok", "query": query, "count": len(results)}
                    if name == "search_project_source": entry["tool"] = name
                    trace.append(entry)
                except Exception as exc:  # Lookup failure must not discard the chapter analysis.
                    payload = {"ok": False, "query": query, "error": str(exc), "results": []}
                    trace.append({"status": "error", "query": query, "error": str(exc)[:300]})
            messages.append({"role": "tool", "tool_call_id": call_id, "name": name or "search_project_knowledge",
                             "content": json.dumps(payload, ensure_ascii=False)})

    messages.append({"role": "user", "content":
                     "知识库工具调用轮次已经结束。请依据本批正文、已提供知识和查询结果，立即输出要求的最终JSON；仍无依据的内容标明未知。"})
    content = await _post(
        messages, temperature=0.2, json_mode=True,
        **resolve_llm("analysis", get_settings()), usage_out=usage_out,
    )
    return _parse_analysis_json(content), content


def _parse_analysis_json(content: str) -> dict:
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError) as exc:
        raise ValueError("原稿分析模型未返回有效 JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("原稿分析模型返回结构无效")
    return parsed


async def project_setting_suggestion_call(project: dict, evidence: list[dict]) -> dict:
    parsed, _ = await draft_analysis_call([
        {"role": "system", "content": (
            render_prompt('project_setting_suggestion_call.system')
        )},
        {"role": "user", "content": (
            render_prompt('project_setting_suggestion_call.user', value_1=json.dumps({key: project.get(key, "") for key in
                ("name", "concept", "characters", "worldbuilding")}, ensure_ascii=False), value_2=json.dumps(evidence, ensure_ascii=False))
        )},
    ])
    return parsed


async def project_knowledge_autofill_call(name: str, preferred_type: str, project: dict,
                                           knowledge: list[dict], sources: list[dict]) -> dict:
    """Create one evidence-bounded, user-reviewable card draft from a supplied name."""
    parsed, _ = await _project_scoped_analysis_call([
        {"role": "system", "content": "\n\n".join([
            render_prompt('shared.draft_system'),
            render_prompt('project_knowledge_autofill_tool.instructions'),
        ])},
        {"role": "user", "content": render_prompt(
            'project_knowledge_autofill_call.user',
            name=name,
            preferred_type=preferred_type or "未指定，由证据判断",
            project=json.dumps({key: project.get(key, "") for key in
                                ("name", "concept", "characters", "worldbuilding")}, ensure_ascii=False),
            knowledge=json.dumps(knowledge, ensure_ascii=False),
            sources=json.dumps(sources, ensure_ascii=False),
        )},
    ])
    return parsed


async def project_knowledge_quote_optimize_call(title: str, summary: str,
                                                 sources: list[dict],
                                                 current_quotes: list[str]) -> dict:
    """Select concise verbatim evidence for one card from explicitly supplied chapters."""
    parsed, _ = await draft_analysis_call([
        {"role": "system", "content": render_prompt('shared.draft_system')},
        {"role": "user", "content": render_prompt(
            'project_knowledge_quote_optimize_call.user',
            title=title,
            summary=summary,
            current_quotes=json.dumps(current_quotes, ensure_ascii=False),
            sources=json.dumps(sources, ensure_ascii=False),
        )},
    ])
    return parsed


def clue_progress_autofill_messages(clue: dict, status: str, chapter: dict,
                                    current_state: dict, plot: dict | None = None,
                                    current_draft: dict | None = None) -> list[dict]:
    """Build the reviewable clue-progress draft request sent to the analysis model."""
    return [
        {"role": "system", "content": "\n\n".join([
            render_prompt('shared.draft_system'),
            render_prompt('clue_progress.autofill_system'),
        ])},
        {"role": "user", "content": render_prompt(
            'clue_progress.autofill',
            clue=json.dumps(clue, ensure_ascii=False),
            status=status,
            current_state=json.dumps(current_state or {}, ensure_ascii=False),
            chapter=json.dumps(chapter, ensure_ascii=False),
            plot=json.dumps(plot or {}, ensure_ascii=False),
            current_draft=json.dumps(current_draft or {}, ensure_ascii=False),
        )},
    ]


async def clue_progress_autofill_call(clue: dict, status: str, chapter: dict,
                                      current_state: dict, plot: dict | None = None,
                                      current_draft: dict | None = None, *,
                                      messages: list[dict] | None = None,
                                      usage_out: dict | None = None) -> tuple[dict, str]:
    """Draft one clue-state explanation with bounded project lookup tools."""
    active = messages if messages is not None else clue_progress_autofill_messages(
        clue, status, chapter, current_state, plot, current_draft)
    return await _project_scoped_analysis_call(active, usage_out=usage_out)


async def project_context_plan_call(draft: str, project: dict, chapter_title: str = "") -> dict:
    messages = [
        {"role": "system", "content": (
            render_prompt('project_context_plan_call.system')
        )},
        {"role": "user", "content": (
            render_prompt('project_context_plan_call.user', value_1=project.get('name',''), value_2=chapter_title or '未指定章节', value_3=draft[:12000])
        )},
    ]
    parsed, _ = await draft_analysis_call(messages)
    return parsed


def _chapter_evidence(chapters: list[dict]) -> str:
    return json.dumps([{"id": chapter["id"], "position": chapter.get("position"),
                        "title": chapter["title"], "text": chapter["text"]}
                       for chapter in chapters], ensure_ascii=False)


def _reading_scope(chapters: list[dict], task: str) -> str:
    scope = json.dumps([{"id": chapter["id"], "position": chapter.get("position"),
                         "title": chapter["title"]} for chapter in chapters], ensure_ascii=False)
    return render_prompt("reading_session.scope", value_1=scope, value_2=task)


async def project_knowledge_auto_groups_call(items: list[dict], chapters: list[dict] | None = None,
                                             reading_messages: list[dict] | None = None) -> dict:
    if reading_messages:
        messages = list(reading_messages) + [{"role": "user", "content": "\n\n".join([
            _reading_scope(chapters or [], "自动发现可合并知识卡片"),
            render_prompt('project_knowledge_auto_groups_call.system'),
            render_prompt('project_knowledge_auto_groups_call.user', value_1=json.dumps(items, ensure_ascii=False)),
        ])}]
        parsed, _ = await draft_analysis_call(messages)
        return parsed
    messages = [{"role": "system", "content": render_prompt('project_knowledge_auto_groups_call.system')}]
    if chapters:
        messages.append({"role": "user", "content": render_prompt(
            'project_knowledge_auto_groups_call.chapters', value_1=_chapter_evidence(chapters))})
    messages.append({"role": "user", "content":
                     render_prompt('project_knowledge_auto_groups_call.user', value_1=json.dumps(items, ensure_ascii=False))})
    parsed, _ = await draft_analysis_call(messages)
    return parsed


async def project_knowledge_graph_layout_call(cards: list[dict], relations: list[dict],
                                              relation_layouts: dict[str, str]) -> dict:
    """Ask the analysis model for semantic groups, leaving coordinate safety to local code."""
    parsed, _ = await draft_analysis_call([
        {"role": "system", "content": render_prompt("project_knowledge_graph_layout_call.system")},
        {"role": "user", "content": render_prompt(
            "project_knowledge_graph_layout_call.user",
            value_1=json.dumps(relation_layouts, ensure_ascii=False),
            value_2=json.dumps(cards, ensure_ascii=False),
            value_3=json.dumps(relations, ensure_ascii=False),
        )},
    ])
    return parsed


async def project_knowledge_merge_call(items: list[dict], related: list[dict] | None = None,
                                       chapters: list[dict] | None = None,
                                       reading_messages: list[dict] | None = None,
                                       previous_draft: dict | None = None,
                                       revision_instruction: str = "") -> dict:
    if reading_messages:
        messages = list(reading_messages) + [
            {"role": "user", "content": "\n\n".join([
                _reading_scope(chapters or [], "生成知识卡片合并草稿"),
                render_prompt('project_knowledge_merge_call.system'),
                render_prompt('project_knowledge_merge_call.user', value_1=json.dumps(items, ensure_ascii=False)),
            ])},
            {"role": "user", "content": render_prompt(
                'project_knowledge_merge_call.context', value_1=json.dumps(related or [], ensure_ascii=False))},
        ]
        if previous_draft:
            messages.append({"role": "user", "content": render_prompt(
                'project_knowledge_merge_call.regenerate',
                value_1=json.dumps(previous_draft, ensure_ascii=False),
                value_2=revision_instruction or "（未提供额外要求，请换一种更清晰、准确的组织方式）")})
        parsed, _ = await draft_analysis_call(messages)
        return parsed
    messages = [{"role": "system", "content": render_prompt('project_knowledge_merge_call.system')}]
    if chapters:
        messages.append({"role": "user", "content": render_prompt(
            'project_knowledge_merge_call.chapters', value_1=_chapter_evidence(chapters))})
    messages.extend([
        {"role": "user", "content": render_prompt(
            'project_knowledge_merge_call.user', value_1=json.dumps(items, ensure_ascii=False))},
        {"role": "user", "content": render_prompt(
            'project_knowledge_merge_call.context', value_1=json.dumps(related or [], ensure_ascii=False))},
    ])
    if previous_draft:
        messages.append({"role": "user", "content": render_prompt(
            'project_knowledge_merge_call.regenerate',
            value_1=json.dumps(previous_draft, ensure_ascii=False),
            value_2=revision_instruction or "（未提供额外要求，请换一种更清晰、准确的组织方式）")})
    parsed, _ = await draft_analysis_call(messages)
    return parsed


async def project_knowledge_audit_call(chapters: list[dict], knowledge: list[dict],
                                       reading_messages: list[dict] | None = None) -> dict:
    if reading_messages:
        parsed, _ = await draft_analysis_call(list(reading_messages) + [{"role": "user", "content": "\n\n".join([
            _reading_scope(chapters, "检查本批章节的知识遗漏"),
            render_prompt('project_knowledge_audit_call.system'),
            render_prompt('clue_progress.instructions'),
            render_prompt('project_knowledge_audit_call.user', value_1=json.dumps(knowledge, ensure_ascii=False),
                          value_2="本批完整正文已经保存在上述阅读会话中，请严格按本次重点章节ID检查。"),
        ])}])
        return parsed
    parsed, _ = await draft_analysis_call([
        {"role": "system", "content": (
            render_prompt('project_knowledge_audit_call.system') + "\n" + render_prompt('clue_progress.instructions')
        )},
        {"role": "user", "content": (
            render_prompt('project_knowledge_audit_call.user', value_1=json.dumps(knowledge, ensure_ascii=False), value_2=json.dumps([{"id": c["id"], "position": c.get("position"), "title": c["title"], "text": c["text"]} for c in chapters], ensure_ascii=False))
        )},
    ])
    return parsed


async def project_context_summary_call(draft: str, evidence: list[dict],
                                       initial_setting: dict, allow_followup: bool = True) -> dict:
    messages = [
        {"role": "system", "content": (
            render_prompt('project_context_summary_call.system')
        )},
        {"role": "user", "content": (
            render_prompt('project_context_summary_call.user', value_1='允许提出补查' if allow_followup else '必须为空', value_2=json.dumps(initial_setting, ensure_ascii=False), value_3=json.dumps(evidence, ensure_ascii=False), value_4=draft[:12000])
        )},
    ]
    parsed, _ = await draft_analysis_call(messages)
    return parsed

async def _post_message(messages, temperature, json_mode=False, retries: int = 3,
                        model: str = "", base_url: str = "", api_key=None,
                        usage_out: dict | None = None, tools: list[dict] | None = None,
                        tool_choice: str | None = None) -> dict:
    s = get_settings()
    use_model = (model or s["model"])
    use_base = (base_url or s["base_url"])
    use_key = api_key if api_key is not None else s["api_key"]
    if not use_key and not is_local_url(use_base):
        raise RuntimeError("未配置 API Key(请在页面设置中填写)")
    payload = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if tools:
        payload["tools"] = tools
        if tool_choice:
            payload["tool_choice"] = tool_choice
    headers = {}
    if use_key:
        headers["Authorization"] = f"Bearer {use_key}"
    # 模型地址已经由用户在页面中明确配置。不要继承启动进程的 HTTP(S)_PROXY，
    # 否则 Codex/终端注入的占位代理（例如 127.0.0.1:9）会让外部 API 全部连接失败。
    async with httpx.AsyncClient(base_url=use_base, timeout=120.0, trust_env=False) as client:
        for attempt in range(retries):
            try:
                r = await client.post(
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                )
                r.raise_for_status()
                data = r.json()
                if usage_out is not None:
                    usage = data.get("usage") or {}
                    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"):
                        value = usage.get(key)
                        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                            usage_out[key] = usage_out.get(key, 0) + value
                    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
                    if "prompt_cache_hit_tokens" not in usage and isinstance(cached, int) and cached >= 0:
                        usage_out["prompt_cache_hit_tokens"] = usage_out.get("prompt_cache_hit_tokens", 0) + cached
                message = data["choices"][0]["message"]
                if not isinstance(message, dict):
                    raise RuntimeError("模型接口返回的消息结构无效")
                return message
            except httpx.HTTPStatusError as exc:
                # 限流/服务端瞬时错误可重试;4xx(如 401/400)不重试
                if exc.response.status_code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                raise
            except httpx.HTTPError:
                # 连接断开/超时等网络层错误,重试
                if attempt < retries - 1:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                raise


async def _post(messages, temperature, json_mode=False, retries: int = 3,
                model: str = "", base_url: str = "", api_key=None, usage_out: dict | None = None) -> str:
    message = await _post_message(
        messages, temperature, json_mode=json_mode, retries=retries,
        model=model, base_url=base_url, api_key=api_key, usage_out=usage_out,
    )
    return message.get("content") or ""


async def hyde_expand(scenario: str) -> str:
    """HyDE:把短场景扩写成一段约150字的假想范文,用于语义检索。"""
    content = await _post(
        [
            {
                "role": "system",
                "content": (
                    render_prompt('hyde_expand.system')
                ),
            },
            {"role": "user", "content": render_prompt('hyde_expand.user', scenario=scenario)},
        ],
        temperature=0.5,
    )
    return (content or "").strip()


async def optimize_search_query(scenario: str) -> dict:
    """把原始写作要求整理成适合 dense/sparse/ColBERT 共用的短查询。"""
    scenario = (scenario or "").strip()
    content = await _post(
        [
            {
                "role": "system",
                "content": (
                    render_prompt('optimize_search_query.system', value_1=render_prompt('shared.query_rules'))
                ),
            },
            {
                "role": "user",
                "content": (
                    render_prompt('optimize_search_query.user', scenario=scenario)
                ),
            },
        ],
        temperature=0.2,
        json_mode=True,
    )
    try:
        data = json.loads(content)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("AI 未返回有效的查询优化结果") from exc
    if not isinstance(data, dict):
        raise ValueError("AI 未返回有效的查询优化结果")
    optimized = str(data.get("optimized_query") or "").strip()
    summary = str(data.get("summary") or "").strip()
    if len(optimized) < 8:
        raise ValueError("AI 返回的优化检索语句过短")
    return {"optimized_query": optimized[:500], "summary": summary[:300]}


async def hyde_expand_multi(scenario: str, n: int = 3) -> list[str]:
    """HyDE:一次生成 n 个不同侧重点的扩写版本,供用户选择/修改后再检索。"""
    content = await _post(
        [
            {
                "role": "system",
                "content": (
                    render_prompt('hyde_expand_multi.system')
                ),
            },
            {"role": "user", "content": render_prompt('hyde_expand_multi.user', scenario=scenario, n=n)},
        ],
        temperature=0.6,
        json_mode=True,
    )
    try:
        data = json.loads(content)
        versions = data.get("versions") if isinstance(data, dict) else None
    except (ValueError, TypeError, AttributeError):
        versions = None
    if isinstance(versions, list):
        cleaned = []
        for v in versions:
            s = re.sub(r"^版本[一二三四五六七八九十\d]+[、:：.]?\s*", "", str(v)).strip()
            if s:
                cleaned.append(s)
        return cleaned
    return []


async def judge_score(scenario: str, batch: list, max_chars: int = 400) -> dict:
    """让 LLM 对一批片段打相关度分。返回 {批内 0-based 下标: int}。"""
    score_max = 3
    lines = [render_prompt('judge_score.header', scenario=scenario, value_2=len(batch))]
    for idx, c in enumerate(batch, 1):
        text = c.get("text") or ""
        if len(text) > max_chars:
            text = text[:max_chars] + "…"
        lines.append(render_prompt('judge_score.section', idx=idx, value_2=c.get('chapter', ''), text=text))
    lines.append(
        render_prompt('judge_score.section_2')
    )
    s = get_settings()
    endpoint = resolve_llm("judge", s)
    content = await _post(
        [
            {"role": "system", "content": render_prompt('judge_score.system')},
            {"role": "user", "content": "\n".join(lines)},
        ],
        temperature=0.1,
        json_mode=True,
        **endpoint,
    )
    try:
        data = json.loads(content)
        items = data.get("judgments") if isinstance(data, dict) else None
    except (ValueError, TypeError, AttributeError):
        items = None
    result = {}
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            jid = item.get("id")
            if not (isinstance(jid, int) and 1 <= jid <= len(batch)):
                continue
            try:
                sc = int(item.get("score"))
            except (TypeError, ValueError):
                sc = 0
            result[jid - 1] = max(0, min(score_max, sc))
    return result


async def select_and_analyze(scenario: str, candidates, final_k: int) -> dict:
    """从候选片段中选出最贴合场景的 final_k 段,并做拆解。"""
    lines = [render_prompt('select_and_analyze.header', scenario=scenario, value_2=len(candidates))]
    for idx, c in enumerate(candidates, 1):
        lines.append(render_prompt('select_and_analyze.section', idx=idx, value_2=c['chapter'], value_3=c['text']))
    lines.append(
        render_prompt('select_and_analyze.section_2', final_k=final_k)
    )
    content = await _post(
        [
            {"role": "system", "content": render_prompt('shared.reference_system')},
            {"role": "user", "content": "\n".join(lines)},
        ],
        temperature=0.3,
        json_mode=True,
    )
    return json.loads(content)


async def select_best(scenario: str, candidates, k: int = 1) -> dict:
    """深度迭代·轮内精选:从候选片段选出最贴合 q0 的 1 段(锚定 q0)。

    返回 {"chunk_id": int, "reason": str};chunk_id 为 1-based 候选下标,失败时为 None。
    """
    lines = [render_prompt('select_best.header', scenario=scenario, value_2=len(candidates))]
    for idx, c in enumerate(candidates, 1):
        lines.append(render_prompt('select_best.section', idx=idx, value_2=c['chapter'], value_3=c['text']))
    lines.append(
        render_prompt('select_best.section_2', k=k)
    )
    content = await _post(
        [
            {"role": "system", "content": render_prompt('select_best.system')},
            {"role": "user", "content": "\n".join(lines)},
        ],
        temperature=0.2,
        json_mode=True,
    )
    try:
        data = json.loads(content)
        cid = data.get("chunk_id") if isinstance(data, dict) else None
        reason = data.get("reason", "") if isinstance(data, dict) else ""
    except (ValueError, TypeError, AttributeError):
        return {"chunk_id": None, "reason": ""}
    if not (isinstance(cid, int) and 1 <= cid <= len(candidates)):
        return {"chunk_id": None, "reason": str(reason)}
    return {"chunk_id": cid, "reason": str(reason)}


async def compare_rounds(scenario: str, candidate: dict, baseline: dict) -> dict:
    """深度迭代·裁判:对比「本轮精选 vs 历史最佳」,判断是否有改进(锚定 q0)。

    candidate / baseline 均为 {"chapter": str, "text": str}。
    返回 {"improved": bool, "reason": str}。
    """
    content = await _post(
        [
            {"role": "system", "content": render_prompt('compare_rounds.system')},
            {"role": "user", "content": (
                render_prompt('compare_rounds.user', scenario=scenario, value_2=baseline.get('chapter', ''), value_3=baseline.get('text', ''), value_4=candidate.get('chapter', ''), value_5=candidate.get('text', ''))
            )},
        ],
        temperature=0.1,
        json_mode=True,
    )
    try:
        data = json.loads(content)
        improved = data.get("improved") if isinstance(data, dict) else False
        reason = data.get("reason", "") if isinstance(data, dict) else ""
    except (ValueError, TypeError, AttributeError):
        return {"improved": False, "reason": "裁判结果解析失败"}
    return {"improved": bool(improved), "reason": str(reason)}


async def rewrite_queries(scenario: str, best_text: str = "", best_chapter: str = "",
                          tried=None, n: int = 3) -> list[str]:
    """深度迭代·查询改写:对比「精选片段 vs q0」的差异,生成 n 个查询变体(强制保持 q0 意图)。

    best_text 为空时(尚未检索到片段)只围绕 q0 换表达。tried 为已尝试过的查询,用于避免重复。
    """
    tried = tried or []
    parts = [render_prompt('rewrite_queries.header', scenario=scenario)]
    if best_text:
        parts.append(render_prompt('rewrite_queries.section', best_chapter=best_chapter, best_text=best_text))
    else:
        parts.append(render_prompt('rewrite_queries.section_2'))
    if tried:
        parts.append(render_prompt('rewrite_queries.section_3', value_1="\n".join(f"- {t}" for t in tried)))
    parts.append(
        render_prompt('rewrite_queries.section_4', n=n)
    )
    content = await _post(
        [
            {"role": "system", "content": render_prompt('rewrite_queries.system')},
            {"role": "user", "content": "\n".join(parts)},
        ],
        temperature=0.6,
        json_mode=True,
    )
    try:
        data = json.loads(content)
        queries = data.get("queries") if isinstance(data, dict) else None
    except (ValueError, TypeError, AttributeError):
        queries = None
    if isinstance(queries, list):
        return [str(q).strip() for q in queries if str(q).strip()][:n]
    return []


def find_span(text: str, quote: str):
    """把 LLM 返回的原文引文定位回文本,返回 (start, end) 或 None。"""
    q = (quote or "").strip().strip('"').strip("“”").strip()
    if not q:
        return None
    idx = text.find(q)
    if idx >= 0:
        return idx, idx + len(q)
    # 兜底:引文可能略有出入,用前 12 字定位
    head = q[:12]
    idx = text.find(head)
    if idx >= 0:
        return idx, idx + len(head)
    return None
