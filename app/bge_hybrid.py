"""BGE-M3 dense+sparse+ColBERT 本地混合精排（可选、按需加载）。"""
import asyncio
import importlib.util
import threading
from pathlib import Path

from . import config


_model = None
_model_lock = threading.Lock()
_last_error = ""


def runtime_status() -> dict:
    """轻量检查安装与模型文件，不触发 2GB 权重加载。"""
    model_dir = Path(config.BGE_HYBRID_MODEL_DIR)
    installed = (
        importlib.util.find_spec("torch") is not None
        and importlib.util.find_spec("FlagEmbedding") is not None
    )
    cuda = None
    if _model is not None:
        import torch
        cuda = bool(torch.cuda.is_available())
    return {
        "enabled": bool(config.BGE_HYBRID_ENABLED),
        "installed": installed,
        "model_ready": (model_dir / "pytorch_model.bin").exists(),
        "cuda": cuda,
        "device": "cuda",
        "loaded": _model is not None,
        "last_error": _last_error,
    }


def _get_model():
    global _model, _last_error
    if _model is not None:
        return _model
    model_dir = Path(config.BGE_HYBRID_MODEL_DIR)
    if not (model_dir / "pytorch_model.bin").exists():
        raise RuntimeError(f"BGE-M3 混合模型文件不完整:{model_dir}")
    try:
        import torch
        from FlagEmbedding import BGEM3FlagModel

        if not torch.cuda.is_available():
            raise RuntimeError("PyTorch 未检测到 CUDA,拒绝在 CPU 上运行 ColBERT 精排")
        _model = BGEM3FlagModel(str(model_dir), use_fp16=True)
        _last_error = ""
        return _model
    except Exception as exc:  # noqa: BLE001
        _last_error = str(exc)[:500]
        raise


def _as_list(value, count: int) -> list[float]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (int, float)):
        return [float(value)]
    result = [float(item) for item in (value or [])]
    if len(result) != count:
        raise ValueError(f"BGE-M3 返回 {len(result)} 个分数,预期 {count} 个")
    return result


def _rerank_sync(query: str, passages: list[str]) -> list[dict]:
    """FlagEmbedding 为同步 GPU API；锁住单卡，避免并发批次争抢显存。"""
    global _last_error
    with _model_lock:
        try:
            model = _get_model()
            pairs = [[query, text] for text in passages]
            scores = model.compute_score(
                pairs,
                batch_size=config.BGE_HYBRID_BATCH_SIZE,
                max_query_length=config.BGE_HYBRID_QUERY_TOKENS,
                max_passage_length=config.BGE_HYBRID_PASSAGE_TOKENS,
                weights_for_different_modes=list(config.BGE_HYBRID_WEIGHTS),
            )
            combined = _as_list(scores["colbert+sparse+dense"], len(passages))
            dense = _as_list(scores["dense"], len(passages))
            sparse = _as_list(scores["sparse"], len(passages))
            colbert = _as_list(scores["colbert"], len(passages))
            _last_error = ""
            return [{
                "index": index,
                "score": combined[index],
                "dense": dense[index],
                "sparse": sparse[index],
                "colbert": colbert[index],
            } for index in sorted(range(len(passages)), key=lambda i: combined[i], reverse=True)]
        except Exception as exc:  # noqa: BLE001
            _last_error = str(exc)[:500]
            raise


async def hybrid_rerank(query: str, passages: list[str]) -> list[dict]:
    """在线程中执行三路精排，避免阻塞 FastAPI 事件循环。"""
    if not config.BGE_HYBRID_ENABLED or not passages:
        return []
    clipped = [text[:config.BGE_HYBRID_MAX_CHARS] for text in passages]
    return await asyncio.to_thread(_rerank_sync, query, clipped)
