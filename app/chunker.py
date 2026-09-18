"""范本分块:逐行拆分 + 章节识别 + 超长硬切 + 块间重叠。

解决两个实际问题:
1. 很多 txt 是"每段一行"(段落间仅单个换行、无空行),必须按单行拆分,
   否则整本会被当成一个巨型段落;
2. 个别段落可能超长(甚至整本无换行),必须硬切到安全长度,
   否则超出 bge-m3 的 8192 token 上下文,embed 会返回 400。
"""
import re
from dataclasses import dataclass, asdict


@dataclass
class Chunk:
    id: str
    chapter: str
    text: str
    para_start: int  # 起始单元序号(含)
    para_end: int    # 结束单元序号(含)


CHAPTER_RE = re.compile(
    r"^(第\s*[0-9一二三四五六七八九十百千万零两]+\s*[章回节卷部篇]|"
    r"Chapter\s+\d+|序章|楔子|引言|尾声|终章|番外|后记|前言|自序)",
    re.IGNORECASE,
)

# 按句末标点切分(用于超长段落的硬切)
_SENT_SPLIT = re.compile(r"(?<=[。！？!?…；;])")


def split_paragraphs(text: str) -> list[str]:
    """按单行拆分(兼容空行分段与每段一行的格式),去掉空行。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.strip() for ln in text.split("\n")]
    return [ln for ln in lines if ln]


def _hard_split(text: str, limit: int) -> list[str]:
    """把超长文本切成 <= limit 的片段:优先句末标点,兜底硬切。"""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    buf = ""
    for sent in _SENT_SPLIT.split(text):
        while len(sent) > limit:  # 单句仍超长时硬切
            out.append(sent[:limit])
            sent = sent[limit:]
        if not sent:
            continue
        if len(buf) + len(sent) > limit:
            if buf:
                out.append(buf)
            buf = sent
        else:
            buf += sent
    if buf:
        out.append(buf)
    return out


def build_chunks(text: str, target: int = 1200, overlap: int = 200, hard_max: int = 3000) -> list[Chunk]:
    lines = split_paragraphs(text)
    if not lines:
        return []

    # 1) 章节标注 + 超长行硬切 -> 单元列表 (chapter, text)
    units: list[tuple[str, str]] = []
    current = "开篇"
    for ln in lines:
        if len(ln) <= 40 and CHAPTER_RE.match(ln):
            current = ln
            continue  # 章节标题行不进入正文检索
        for piece in _hard_split(ln, hard_max):
            units.append((current, piece))

    if not units:
        return []

    # 2) 按 target 聚合为块,带块间重叠,且绝不超出 hard_max
    chunks: list[Chunk] = []

    def emit(buf, chapter, start, end):
        chunks.append(Chunk(
            id=f"c{len(chunks):05d}",
            chapter=chapter,
            text="\n\n".join(buf),
            para_start=start,
            para_end=end,
        ))

    buf: list[str] = []
    buf_len = 0
    buf_chapter = units[0][0]
    start_idx = 0

    for idx, (ch, piece) in enumerate(units):
        # 硬上限保护:非空缓冲 + 新单元会超限时,先封块再开新块
        if buf and buf_len + len(piece) > hard_max:
            emit(buf, buf_chapter, start_idx, idx - 1)
            buf, buf_len = [], 0
            buf_chapter = ch
            start_idx = idx
        buf.append(piece)
        buf_len += len(piece)
        if buf_len >= target:
            emit(buf, buf_chapter, start_idx, idx)
            # 从尾部取不超过 overlap 的完整单元,带入下一块
            nbuf: list[str] = []
            nlen = 0
            for tail in reversed(buf):
                if nlen + len(tail) > overlap:
                    break
                nbuf.insert(0, tail)
                nlen += len(tail)
            start_idx = idx - len(nbuf) + 1
            buf, buf_len = nbuf, nlen
            if start_idx < len(units):
                buf_chapter = units[start_idx][0]
            else:
                buf_chapter = ch

    if buf:
        emit(buf, buf_chapter, start_idx, len(units) - 1)

    return chunks
