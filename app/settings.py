"""运行时设置,持久化到 data/settings.json,优先级高于 .env。

四个 AI 端点统一用「模型 / 地址 / 密钥」三元组管理,密钥可为空(本地 Ollama 无需密钥):
- 原稿分析模型:analysis_model / analysis_base_url / analysis_api_key
- 主 LLM(精选 / 扩写):model / base_url / api_key
- 判断模型:judge_model / judge_base_url / judge_api_key
- Embedding:embed_model / embed_base_url / embed_api_key

前端可随时修改,保存后即时生效(无需重启),因为 llm.py / ollama_client.py 每次调用都会重新读取。
"""
import json

from . import config
from .net import is_local_url

SETTINGS_FILE = config.DATA_DIR / "settings.json"

_KEYS = (
    "api_key", "base_url", "model",
    "analysis_model", "analysis_base_url", "analysis_api_key",
    "analysis_context_tokens",
    "judge_model", "judge_base_url", "judge_api_key",
    "embed_model", "embed_base_url", "embed_api_key", "embed_provider",
    # 检索参数默认值(持久化,方便重复使用同一套配置)
    "mode", "draft_retrieval_mode",
    "fast_recall", "fast_rerank", "fast_topk",
    "refine_recall", "refine_rounds", "refine_batch", "refine_topk",
    "refine_judge_chars",
    "deep_recall", "deep_batch", "deep_topk", "deep_judge_chars",
    "deep_variants", "deep_retry",
)


def get() -> dict:
    s = {
        "api_key": config.DEEPSEEK_API_KEY,
        "base_url": config.DEEPSEEK_BASE_URL,
        "model": config.DEEPSEEK_MODEL,
        "analysis_model": "",
        "analysis_base_url": "",
        "analysis_api_key": "",
        # 留空时按已知模型推断；未知模型继续使用保守的章节批次上限。
        "analysis_context_tokens": "",
        "judge_model": "",
        "judge_base_url": "",
        "judge_api_key": "",
        "embed_provider": "auto",
        "embed_model": config.EMBED_MODEL,
        "embed_base_url": config.OLLAMA_BASE_URL,
        "embed_api_key": "",
        "mode": "fast",
        "draft_retrieval_mode": "fast",
        "fast_recall": str(config.RECALL_K),
        "fast_rerank": str(config.RERANK_K),
        "fast_topk": str(config.TOP_K),
        "refine_recall": str(config.REFINE_RECALL),
        "refine_rounds": str(config.REFINE_ROUNDS),
        "refine_batch": str(config.REFINE_BATCH),
        "refine_topk": str(config.TOP_K),
        "refine_judge_chars": str(config.JUDGE_MAX_CHARS),
        "deep_recall": str(config.DEEP_RECALL),
        "deep_batch": str(config.DEEP_BATCH),
        "deep_topk": str(config.TOP_K),
        "deep_judge_chars": str(config.JUDGE_MAX_CHARS),
        "deep_variants": str(config.DEEP_VARIANTS),
        "deep_retry": str(config.DEEP_RETRY),
    }
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            for k in _KEYS:
                if k in saved and saved[k] is not None:
                    s[k] = str(saved[k]).strip()
        except (json.JSONDecodeError, OSError):
            pass
    return s


def save(new: dict) -> dict:
    s = get()
    for k in _KEYS:
        if k in new and new[k] is not None:
            s[k] = str(new[k]).strip()
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
    return s


def resolve_llm(role: str, current: dict | None = None) -> dict:
    """一次读取完整端点；空字段动态继承主 LLM，本地独立服务允许免鉴权。"""
    if role not in ("analysis", "judge"):
        raise ValueError("Unknown LLM role")
    s = get() if current is None else current
    value = lambda name: str(s.get(name) or "").strip()
    base = value(f"{role}_base_url")
    key = value(f"{role}_api_key")
    if not key and (not base or base.rstrip("/") == value("base_url").rstrip("/") or not is_local_url(base)):
        key = value("api_key")
    return {"model": value(f"{role}_model") or value("model"),
            "base_url": base or value("base_url"), "api_key": key}


def llm_resolution_summary(current: dict) -> dict:
    """供设置页核对生效配置；仅显示密钥来源，不返回密钥内容。"""
    result = {}
    for role in ("analysis", "judge"):
        endpoint = resolve_llm(role, current)
        key = endpoint.pop("api_key")
        endpoint["key_source"] = ("own" if current.get(f"{role}_api_key") else "main") if key else "none"
        result[role] = endpoint
    return result


def analysis_context_tokens(current: dict | None = None) -> int:
    """返回分析模型上下文长度；自定义值优先，已知模型才自动放大。"""
    current = current or get()
    raw = str(current.get("analysis_context_tokens") or "").strip()
    if raw:
        try:
            return min(4_000_000, max(16_000, int(raw)))
        except ValueError:
            pass
    model = str(current.get("analysis_model") or current.get("model") or "").casefold()
    if "deepseek-v4" in model or "[1m]" in model:
        return 1_000_000
    # 未知兼容端点可能只有 32K/64K，不能因 DeepSeek 的能力盲目放大。
    return 128_000


def knowledge_chapter_char_limit(current: dict | None = None) -> int:
    """给知识整理正文保留充足 token，用于卡片目录、提示词、思考与输出。"""
    current = current or get()
    explicit = bool(str(current.get("analysis_context_tokens") or "").strip())
    model = str(current.get("analysis_model") or current.get("model") or "").casefold()
    known_million_context = "deepseek-v4" in model or "[1m]" in model
    if not explicit and not known_million_context:
        return 30_000
    return min(300_000, max(30_000, int(analysis_context_tokens(current) * 0.30)))
