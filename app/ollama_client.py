"""Embedding 客户端:支持本地 Ollama(/api/embed)与 OpenAI 兼容(/embeddings)两种协议。

- 本地 Ollama:无需密钥,trust_env=False 绕过系统代理(如 Clash)。
- OpenAI 兼容服务:按服务商要求配置密钥；远程地址走系统代理。
"""
from urllib.parse import urlsplit

import httpx

from .config import OLLAMA_BASE_URL, EMBED_MODEL
from .net import is_local_url
from .settings import get as get_settings


def embedding_provider(current: dict | None = None) -> str:
    s = current if current is not None else get_settings()
    provider = s.get("embed_provider") or "auto"
    if provider in ("ollama", "openai"):
        return provider
    base = (s.get("embed_base_url") or OLLAMA_BASE_URL).rstrip("/")
    parsed = urlsplit(base)
    path = parsed.path
    if path.endswith(("/v1", "/embeddings")):
        return "openai"
    # 协议与部署位置无关；只保留 Ollama 的明确路径和默认端口提示。
    if path.endswith("/api/embed") or (not path and parsed.port == 11434):
        return "ollama"
    return "openai"


def embedding_endpoint(base: str, provider: str) -> str:
    suffix = "/embeddings" if provider == "openai" else "/api/embed"
    return base if base.endswith(suffix) else base + suffix


def _raise_embedding_error(resp: httpx.Response) -> None:
    if not resp.is_error:
        return
    try:
        payload = resp.json()
        detail = payload.get("error") or payload.get("detail") or resp.text
    except (ValueError, TypeError):
        detail = resp.text
    detail = str(detail or "未知错误").strip()[:500]
    hint = "额度不足或请求受限，请检查服务额度，稍后重试或更换向量服务。" if resp.status_code in (402, 429) else ""
    raise RuntimeError(f"Embedding 服务返回 {resp.status_code}：{hint}{detail}")


async def embed(texts: list[str]) -> list[list[float]]:
    """批量把文本向量化。返回与 texts 等长的向量列表。"""
    if not texts:
        return []
    s = get_settings()
    use_base = (s.get("embed_base_url") or OLLAMA_BASE_URL).rstrip("/")
    use_model = s.get("embed_model") or EMBED_MODEL
    use_key = s.get("embed_api_key") or ""
    trust_env = not is_local_url(use_base)
    provider = embedding_provider(s)
    is_openai = provider == "openai"
    endpoint = embedding_endpoint(use_base, provider)
    headers = {}
    if use_key:
        headers["Authorization"] = f"Bearer {use_key}"
    async with httpx.AsyncClient(base_url=use_base, timeout=180.0, trust_env=trust_env) as client:
        if is_openai:
            resp = await client.post(
                endpoint, json={"model": use_model, "input": texts}, headers=headers
            )
            _raise_embedding_error(resp)
            data = resp.json()["data"]
            data = sorted(data, key=lambda d: d.get("index", 0))
            return [d["embedding"] for d in data]
        resp = await client.post(
            endpoint, json={"model": use_model, "input": texts}, headers=headers
        )
        _raise_embedding_error(resp)
        return resp.json()["embeddings"]


async def check_ollama() -> bool:
    """检查本地 Ollama 服务是否在线(仅用于状态栏提示)。"""
    try:
        async with httpx.AsyncClient(
            base_url=(get_settings().get("embed_base_url") or OLLAMA_BASE_URL).rstrip("/").removesuffix("/api/embed"), timeout=5.0, trust_env=False
        ) as client:
            r = await client.get("/api/tags")
            r.raise_for_status()
            return True
    except httpx.HTTPError:
        return False
