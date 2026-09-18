"""全局配置:全部支持环境变量覆盖(优先读取项目根目录 .env 文件)。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path):
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(BASE_DIR / ".env")

# Ollama(本机 bge-m3)
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "bge-m3")
# BGE-M3 官方说明无需查询指令前缀；仅为兼容其他 embedding 模型保留环境变量覆盖。
QUERY_INSTRUCTION = os.getenv("QUERY_INSTRUCTION", "")

# 可选 BGE-M3 三路混合精排。模型按需加载；失败时检索自动回退到现有 dense 流程。
BGE_HYBRID_ENABLED = os.getenv("BGE_HYBRID_ENABLED", "1").strip().lower() not in ("0", "false", "no")
BGE_HYBRID_MODEL_DIR = Path(os.getenv("BGE_HYBRID_MODEL_DIR", BASE_DIR / "data" / "models" / "bge-m3"))
BGE_HYBRID_POOL_MULTIPLIER = int(os.getenv("BGE_HYBRID_POOL_MULTIPLIER", "3"))
# 精细/深度模式会先扩大 dense 候选池、再由混合模型筛回用户设定的召回数。
# 上限用于避免把极端参数放大成过大的 ColBERT 批次。
BGE_HYBRID_POOL_MAX = int(os.getenv("BGE_HYBRID_POOL_MAX", "200"))
BGE_HYBRID_BATCH_SIZE = int(os.getenv("BGE_HYBRID_BATCH_SIZE", "6"))
BGE_HYBRID_QUERY_TOKENS = int(os.getenv("BGE_HYBRID_QUERY_TOKENS", "192"))
BGE_HYBRID_PASSAGE_TOKENS = int(os.getenv("BGE_HYBRID_PASSAGE_TOKENS", "512"))
BGE_HYBRID_MAX_CHARS = int(os.getenv("BGE_HYBRID_MAX_CHARS", "1800"))
BGE_HYBRID_WEIGHTS = tuple(
    float(value) for value in os.getenv("BGE_HYBRID_WEIGHTS", "0.35,0.20,0.45").split(",")
)

# DeepSeek(LLM 精读)
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

# 路径
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
INDEX_DIR = DATA_DIR / "index"
UPLOAD_DIR = DATA_DIR / "uploads"
PROJECTS_DIR = DATA_DIR / "projects"

for _d in (DATA_DIR, INDEX_DIR, UPLOAD_DIR, PROJECTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# 分块参数(见 设计方案.md §2.1)
CHUNK_TARGET_CHARS = int(os.getenv("CHUNK_TARGET_CHARS", "1200"))
CHUNK_OVERLAP_CHARS = int(os.getenv("CHUNK_OVERLAP_CHARS", "200"))
# 单块硬上限(字符):任何块不得超过此值,以免超出 bge-m3 上下文
CHUNK_HARD_MAX = int(os.getenv("CHUNK_HARD_MAX", "3000"))

# 检索参数
TOP_K = int(os.getenv("TOP_K", "3"))
EMBED_BATCH = int(os.getenv("EMBED_BATCH", "32"))
# 单条知识卡可能在多次补充后远长于普通正文分块。嵌入前按更保守的
# 字符上限拆分，避免本地模型按 token 计数时超过上下文窗口。
EMBED_INPUT_MAX_CHARS = int(os.getenv("EMBED_INPUT_MAX_CHARS", "2000"))
# 每个命中块里本地高亮的句子数(LLM 精读未启用时的兜底)
HIGHLIGHT_SENTS = int(os.getenv("HIGHLIGHT_SENTS", "2"))

# 智能精读检索参数(召回 → 本地重排 → LLM 精选)
RECALL_K = int(os.getenv("RECALL_K", "24"))
RERANK_K = int(os.getenv("RERANK_K", "8"))

# 扩写检索:一次生成几个扩写版本供用户选择
EXPAND_VERSIONS = int(os.getenv("EXPAND_VERSIONS", "3"))

# 迭代式检索(LLM 判断相关性 + 伪相关反馈)默认参数
REFINE_RECALL = int(os.getenv("REFINE_RECALL", "50"))
REFINE_ROUNDS = int(os.getenv("REFINE_ROUNDS", "2"))
REFINE_BATCH = int(os.getenv("REFINE_BATCH", "5"))
# 判断相关性时每段送入 LLM 的最大字符数(截断,节省 token)
JUDGE_MAX_CHARS = int(os.getenv("JUDGE_MAX_CHARS", "400"))

# 深度迭代(LLM 查询改写 + 裁判闭环)默认参数
DEEP_RECALL = int(os.getenv("DEEP_RECALL", "50"))
DEEP_BATCH = int(os.getenv("DEEP_BATCH", "5"))
# 每次「AI 改写查询」生成的候选查询数(手动模式选一个)
DEEP_VARIANTS = int(os.getenv("DEEP_VARIANTS", "3"))
# 自动迭代:连续"无更好结果"多少轮后停止(0=第一次无改进即停)
DEEP_RETRY = int(os.getenv("DEEP_RETRY", "1"))
# 自动迭代的硬性轮数上限(防跑飞)
DEEP_MAX_ROUNDS = int(os.getenv("DEEP_MAX_ROUNDS", "15"))
