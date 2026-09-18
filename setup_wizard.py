"""Interactive first-run setup. Standard library only; no application imports."""
import getpass
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parent
MIN_VERSION = (3, 10)


def yes(prompt, default=False):
    suffix = " [Y/n] " if default else " [y/N] "
    answer = input(prompt + suffix).strip().lower()
    return default if not answer else answer in ("y", "yes", "是")


def ask(prompt, default=""):
    value = input(prompt + (" [" + default + "]" if default else "") + "：").strip()
    return value or default


def secret(prompt, old=""):
    print(prompt + ("（已有密钥：回车保留，输入 - 清空）" if old else "（输入不回显；本地服务可留空）"))
    value = getpass.getpass("密钥：").strip()
    return "" if value == "-" else value or old


def ask_model(prompt, default=""):
    while True:
        model = ask(prompt, default)
        if model:
            return model
        print("请填写服务实际提供的模型名称。")


def endpoint(value, compatible=False, local=False):
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("地址需为 http(s) 服务地址，不要包含密钥、查询参数或账号密码。")
    loopback = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if local and not loopback:
        raise ValueError("本地 Ollama 请使用 localhost、127.0.0.1 或 ::1。")
    if not loopback and parsed.scheme != "https":
        raise ValueError("远程服务请使用 HTTPS 地址。")
    return value


def ask_endpoint(prompt, default, **kwargs):
    while True:
        try:
            return endpoint(ask(prompt, default), **kwargs)
        except ValueError as exc:
            print(exc)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, payload=None, key=""):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers=headers)
    handlers = [NoRedirect()]
    if urlsplit(url).hostname in ("localhost", "127.0.0.1", "::1"):
        handlers.append(ProxyHandler({}))
    try:
        with build_opener(*handlers).open(request, timeout=25) as response:
            return json.loads(response.read(2_000_000))
    except HTTPError as exc:
        # Do not print service response bodies: they may echo credentials.
        raise ValueError("服务返回 HTTP %s；请检查地址、权限和模型名称。" % exc.code) from None
    except (URLError, TimeoutError, OSError):
        raise ValueError("连接失败或超时；请检查服务是否启动及网络连接。") from None
    except (ValueError, UnicodeError):
        raise ValueError("服务没有返回可解析的 JSON。") from None


def probe_embedding(base, model, key="", provider="auto"):
    compatible = provider == "openai" or (provider == "auto" and base.endswith(("/v1", "/embeddings")))
    suffix = "/embeddings" if compatible else "/api/embed"
    result = request_json(base if base.endswith(suffix) else base + suffix,
                          {"model": model, "input": ["这是一次向量连接测试。"]}, key)
    try:
        vector = result["data"][0]["embedding"] if compatible else result["embeddings"][0]
        if not isinstance(vector, list) or not vector or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in vector):
            raise ValueError()
        return len(vector)
    except (KeyError, IndexError, TypeError, ValueError):
        raise ValueError("接口可连接，但未返回有效向量；聊天接口不能代替 Embedding 接口。") from None


def probe_llm(base, model, key=""):
    result = request_json(base + "/chat/completions", {
        "model": model, "messages": [{"role": "user", "content": "请只回答 OK。"}],
        "max_tokens": 32, "stream": False,
    }, key)
    try:
        if not result["choices"][0]["message"].get("content"):
            raise ValueError()
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        raise ValueError("接口响应了，但没有返回聊天文本，请核对模型兼容性。") from None


def json_object(path):
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, OSError):
        raise ValueError("已有配置文件无法读取，已停止以避免覆盖：" + path.name) from None


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(str(temp), str(path))
    finally:
        if temp.exists():
            temp.unlink()


def data_directory():
    values = {}
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    value = os.environ.get("DATA_DIR", values.get("DATA_DIR", str(ROOT / "data")))
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def ensure_environment():
    if sys.version_info[:2] < MIN_VERSION:
        print("需要 Python 3.10 或以上。安装管理器可执行：py install 3.10")
        return None
    python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if python.exists():
        check = subprocess.run([str(python), "-c", "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)"], capture_output=True)
        if check.returncode:
            print("已有 .venv 版本过旧或无法运行；不会覆盖它。请参照 README 重建环境。")
            return None
    else:
        print("正在创建项目独立 Python 环境 .venv……")
        subprocess.run([sys.executable, "-m", "venv", str(ROOT / ".venv")], check=True)
    code = "import fastapi, uvicorn, httpx, numpy, multipart"
    if subprocess.run([str(python), "-c", code], capture_output=True).returncode:
        print("正在联网安装 requirements.txt 中的基础依赖，请等待；失败时可重新运行 setup.bat。")
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], check=True)
        if subprocess.run([str(python), "-c", code], capture_output=True).returncode:
            raise ValueError("安装后依赖仍无法导入，请保留终端报错并检查 Python 环境。")
    print("Python 和基础依赖检查通过。")
    return python


def configure():
    data_dir = data_directory()
    path = data_dir / "settings.json"
    current = json_object(path)
    if current and not yes("已有设置。修改模型连接？其他设置会保留"):
        return False
    if (data_dir / "index").exists() or (data_dir / "projects").exists():
        print("如果更换 Embedding 服务或模型，已有范本和项目的向量索引需要重新建立。")
    print("\n向量模型负责检索；聊天模型负责分析、精选与知识整理。")
    print("1. 本地 Ollama（已安装或准备安装）\n2. 远程 Embedding API\n3. 先体验页面和正文管理，暂不配置模型")
    while True:
        choice = ask("请选择 1 / 2 / 3", "3")
        if choice in ("1", "2", "3"):
            break
    if choice == "3":
        print("暂未验证模型连接；语义检索与 AI 分析需配置后才能使用。")
        return False
    updated = dict(current)
    embedding_ok = False
    llm_ok = False
    if choice == "1":
        base = ask_endpoint("Ollama 本机地址", "http://127.0.0.1:11434", local=True)
        model = ask_model("Embedding 模型名", "bge-m3")
        key = ""
        try:
            tags = request_json(base + "/api/tags")
            if not isinstance(tags, dict) or not isinstance(tags.get("models"), list):
                raise ValueError("该地址没有返回 Ollama 模型列表。")
            names = [x.get("name", "") for x in tags["models"] if isinstance(x, dict)]
            print("本机已有模型：" + (", ".join(names) or "无"))
            if model not in names and model + ":latest" not in names:
                print("尚未找到所选模型。需要先下载模型权重，可能耗时较长。")
                if shutil.which("ollama") and yes("现在用 ollama pull 下载所选模型？"):
                    env = dict(os.environ, OLLAMA_HOST=base)
                    subprocess.run(["ollama", "pull", model], check=True, env=env)
        except ValueError as exc:
            print(str(exc))
            print("请先从 https://ollama.com 安装并启动 Ollama，再运行：ollama pull bge-m3")
    else:
        print("请使用 OpenAI 兼容的向量服务，可填写 API 基础地址或完整 /embeddings 地址；聊天接口不能替代。")
        base = ask_endpoint("Embedding 服务地址", current.get("embed_base_url", "") if current.get("embed_base_url", "").startswith("https://") else "", compatible=True)
        model = ask_model("服务商提供的 Embedding 模型名", current.get("embed_model", "bge-m3"))
        key = secret("Embedding API", current.get("embed_api_key", "") if base == current.get("embed_base_url") else "")
    if yes("发送一句固定测试文本，检查向量接口？远程服务可能计费", True):
        try:
            print("向量连接通过，维度：", probe_embedding(base, model, key, "ollama" if choice == "1" else "openai"))
            embedding_ok = True
        except ValueError as exc:
            print("向量检查未通过：", exc)
    updated.update(embed_base_url=base, embed_model=model, embed_api_key=key,
                   embed_provider="ollama" if choice == "1" else "openai")
    if yes("现在配置聊天模型，用于 AI 精选与知识整理？", True):
        print("本地 Ollama 聊天地址通常为 http://127.0.0.1:11434/v1；远程服务填兼容聊天地址。")
        chat_base = ask_endpoint("聊天 API 地址", current.get("base_url") or "https://api.deepseek.com")
        chat_model = ask_model("聊天模型名", current.get("model") or "deepseek-chat")
        chat_key = secret("聊天 API", current.get("api_key", "") if chat_base == current.get("base_url") else "")
        if yes("发送一条短消息检查聊天接口？远程服务可能计费", True):
            try:
                probe_llm(chat_base, chat_model, chat_key)
                print("聊天连接通过。")
                llm_ok = True
            except ValueError as exc:
                print("聊天检查未通过：", exc)
        updated.update(base_url=chat_base, model=chat_model, api_key=chat_key)
        if any(current.get(k) for k in ("analysis_model", "judge_model")):
            print("已有独立分析/判断模型配置保持原样；本次仅检查主聊天模型。")
        else:
            print("分析和判断阶段默认复用主聊天模型；可在页面设置中分别调整。")
    print("\n检查摘要：Embedding %s；主聊天 %s。" % ("通过" if embedding_ok else "未验证或未通过", "通过" if llm_ok else "未验证或未通过"))
    print("连接检查只验证接口响应，不等于检索质量验证。密钥会保存在本机设置文件中。")
    if not yes("保存以上配置？", True):
        print("配置未保存。")
        return False
    atomic_json(path, updated)
    print("已保存配置；若服务已运行，请重启以更新索引和连接状态。")
    return True


def main():
    os.chdir(str(ROOT))
    print("小说创作工作台 · 环境准备\n自动检查 Python、创建 .venv 并安装基础依赖。请先关闭正在运行的工作台服务。")
    if not ensure_environment():
        return 1
    # Never overwrite existing credentials or custom GPU choices.
    if not (ROOT / ".env").exists():
        shutil.copyfile(str(ROOT / ".env.example"), str(ROOT / ".env"))
    atomic_json(data_directory() / "setup-state.json", {"wizard_visited": True, "visited_at": int(time.time())})
    print("\n环境准备完成。通过 bat 启动时将自动进入网页；首次打开会提供可跳过的入门引导。")
    print("请在网页的“设置”中配置模型；也可以先体验不需要模型的正文编辑与保存。")
    return 0


if __name__ == "__main__":
    try:
        if "--needs-setup" in sys.argv:
            raise SystemExit(0 if (ROOT / ".env").exists() and (data_directory() / "setup-state.json").exists() else 1)
        raise SystemExit(main())
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。未保存的模型设置不会写入。")
        raise SystemExit(1)
    except subprocess.CalledProcessError:
        print("命令执行失败，请查看上方输出；未将本次向导标记为完成。")
        raise SystemExit(1)
    except (OSError, ValueError) as exc:
        print("配置未完成：", exc)
        raise SystemExit(1)
