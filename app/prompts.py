"""Editable prompt templates and local presets; runtime data is never persisted here."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from uuid import uuid4

from . import config

PRESETS_FILE = config.DATA_DIR / "prompt_presets.json"
CATALOG = json.loads(Path(__file__).with_name("prompt_defaults.json").read_text(encoding="utf-8"))
_BY_ID = {entry["id"]: entry for entry in CATALOG}
_PLACEHOLDER = re.compile(r"\{\{([a-zA-Z_][a-zA-Z_0-9]*)\}\}")
_lock = RLock()
_snapshot: ContextVar[dict | None] = ContextVar("prompt_snapshot", default=None)


def _read() -> dict:
    try:
        data = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"active_id": "default", "presets": []}
    except (ValueError, OSError) as exc:
        raise ValueError("提示词方案文件无法读取，请检查 data/prompt_presets.json；未覆盖原文件") from exc
    if not isinstance(data, dict) or not isinstance(data.get("presets"), list):
        raise ValueError("提示词方案文件格式无效")
    return data


def _write(data: dict) -> None:
    PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".prompt-", suffix=".tmp", dir=PRESETS_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(name, PRESETS_FILE)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _validate(overrides: dict) -> dict:
    if not isinstance(overrides, dict) or set(overrides) - set(_BY_ID):
        raise ValueError("包含未知提示词，请刷新页面后重试")
    result = {}
    for key, value in overrides.items():
        if not isinstance(value, str) or not value.strip() or len(value) > 20000:
            raise ValueError(f"{_BY_ID[key]['title']}：提示词不能为空或超过20000字")
        required = set(_PLACEHOLDER.findall(_BY_ID[key]["template"]))
        if set(_PLACEHOLDER.findall(value)) != required:
            raise ValueError(f"{_BY_ID[key]['title']}：请保留原有的全部双花括号变量，不要新增变量")
        if value != _BY_ID[key]["template"]:
            result[key] = value
    return result


def current_templates() -> dict:
    if _snapshot.get() is not None:
        return _snapshot.get()
    data = _read()
    active = next((p for p in data["presets"] if p["id"] == data["active_id"]), None)
    return _validate(active.get("overrides", {})) if active else {}


@contextmanager
def frozen_prompts():
    """A request and its child tasks keep one template version while users switch presets."""
    token = _snapshot.set(dict(current_templates()))
    try:
        yield
    finally:
        _snapshot.reset(token)


def revision() -> str:
    return hashlib.sha256(json.dumps(current_templates(), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def render_prompt(prompt_id: str, **variables) -> str:
    template = current_templates().get(prompt_id, _BY_ID[prompt_id]["template"])
    required = set(_PLACEHOLDER.findall(template))
    if required != set(variables):
        raise ValueError(f"提示词 {prompt_id} 的运行变量不匹配")
    # One pass: braces in manuscript text are data and never expanded again.
    return _PLACEHOLDER.sub(lambda match: str(variables[match.group(1)]), template)


def catalog() -> dict:
    data = _read()
    overrides = current_templates()
    return {"active_id": data["active_id"], "presets": [{"id": "default", "name": "内置默认", "readonly": True}] +
            [{"id": p["id"], "name": p["name"], "readonly": False} for p in data["presets"]],
            "prompts": [dict(entry, default=entry["template"], template=overrides.get(entry["id"], entry["template"])) for entry in CATALOG]}


def save_preset(name: str, overrides: dict, preset_id: str = "") -> str:
    name = str(name).strip()
    if not name or len(name) > 80:
        raise ValueError("方案名称必填，最多80字")
    clean = _validate(overrides)
    with _lock:
        data = _read()
        if preset_id == "default":
            raise ValueError("内置方案不可覆盖，请另存为新方案")
        existing = next((p for p in data["presets"] if p["id"] == preset_id), None)
        if preset_id and existing is None:
            raise ValueError("方案不存在，请刷新")
        if any(p["name"] == name and p["id"] != preset_id for p in data["presets"]):
            raise ValueError("已有同名方案，请更换名称或保存当前方案")
        if existing is None:
            if len(data["presets"]) >= 100:
                raise ValueError("最多保存100个方案，请先删除不再使用的方案")
            existing = {"id": "pp_" + uuid4().hex[:24]}
            data["presets"].append(existing)
        existing.update(name=name, overrides=clean)
        data["active_id"] = existing["id"]
        _write(data)
        return existing["id"]


def activate(preset_id: str) -> None:
    with _lock:
        data = _read()
        if preset_id != "default" and not any(p["id"] == preset_id for p in data["presets"]):
            raise ValueError("方案不存在")
        data["active_id"] = preset_id
        _write(data)


def delete(preset_id: str) -> None:
    with _lock:
        data = _read()
        if preset_id == "default" or not any(p["id"] == preset_id for p in data["presets"]):
            raise ValueError("内置方案不可删除，或方案不存在")
        data["presets"] = [p for p in data["presets"] if p["id"] != preset_id]
        if data["active_id"] == preset_id:
            data["active_id"] = "default"
        _write(data)
