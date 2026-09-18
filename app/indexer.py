"""多作品向量索引:每个作品一个子目录(chunks.json + vecs.npy + meta.json)。"""
import hashlib
import json
import shutil
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np


class IndexCompatibilityError(ValueError):
    """索引与当前 embedding 配置不兼容。"""


def _model_key(model: str) -> str:
    return (model or "").strip().casefold()


def work_id_of(name: str) -> str:
    return "w" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:12]


class VectorIndex:
    def __init__(self, base_dir: Path):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    def work_dir(self, work_id: str) -> Path:
        return self.base / work_id

    def save(self, work_id, name, chunks, vectors, model=""):
        d = self.work_dir(work_id)
        d.mkdir(parents=True, exist_ok=True)
        data = [asdict(c) if hasattr(c, "__dataclass_fields__") else dict(c) for c in chunks]
        (d / "chunks.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        np.save(d / "vecs.npy", np.asarray(vectors, dtype=np.float32))
        meta = {
            "id": work_id,
            "name": name,
            "chunks": len(data),
            "model": model,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        (d / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return meta

    def load(self, work_id, expected_model: str = "", adopt_legacy_model: bool = False):
        d = self.work_dir(work_id)
        cp, vp, mp = d / "chunks.json", d / "vecs.npy", d / "meta.json"
        if not (cp.exists() and vp.exists()):
            return None
        chunks = json.loads(cp.read_text(encoding="utf-8"))
        vectors = np.load(vp)
        meta = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {"id": work_id, "name": work_id}
        if vectors.ndim != 2 or len(vectors) != len(chunks):
            raise IndexCompatibilityError("索引文件不完整或向量数量与片段数量不一致，请重新建立索引")
        stored_model = str(meta.get("model") or "").strip()
        expected_model = str(expected_model or "").strip()
        if expected_model and stored_model and _model_key(stored_model) != _model_key(expected_model):
            raise IndexCompatibilityError(
                f"该索引由 {stored_model} 建立，当前向量模型是 {expected_model}，请重新上传范本建立索引"
            )
        if expected_model and not stored_model:
            if not adopt_legacy_model:
                raise IndexCompatibilityError("该旧索引缺少向量模型信息，请重新建立索引")
            # 历史版本没有写入模型名；首次升级时按当时配置认领，之后即可严格校验切换。
            meta["model"] = expected_model
            meta["legacy_model_assumed"] = True
            mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return chunks, vectors, meta

    def list_works(self):
        works = []
        for sub in sorted(self.base.iterdir()):
            if sub.is_dir():
                mp = sub / "meta.json"
                if mp.exists():
                    try:
                        works.append(json.loads(mp.read_text(encoding="utf-8")))
                    except (json.JSONDecodeError, OSError):
                        pass
        works.sort(key=lambda w: w.get("created_at", ""), reverse=True)
        return works

    def delete(self, work_id) -> bool:
        d = self.work_dir(work_id)
        if d.exists():
            shutil.rmtree(d)
            return True
        return False

    def migrate_legacy(self):
        """把旧版单索引(data/index 下的 chunks.json + vecs.npy)迁移成作品。"""
        old_chunks = self.base / "chunks.json"
        old_vecs = self.base / "vecs.npy"
        if not (old_chunks.exists() and old_vecs.exists()):
            return None
        chunks = json.loads(old_chunks.read_text(encoding="utf-8"))
        vectors = np.load(old_vecs)
        name = "未命名作品"
        if chunks and chunks[0].get("text"):
            first = chunks[0]["text"].split("\n")[0].strip()
            for sep in ("：", ":"):
                if first.startswith("书名" + sep):
                    t = first.split(sep, 1)[1].strip()
                    if t:
                        name = t
                    break
        wid = work_id_of(name)
        self.save(wid, name, chunks, vectors)
        old_chunks.unlink(missing_ok=True)
        old_vecs.unlink(missing_ok=True)
        return wid
