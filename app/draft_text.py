"""原稿分段与引文定位工具。"""
import re


_QUOTE_TRANSLATION = str.maketrans({
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
})


def _append_segment(result: list[dict], draft: str, start: int, end: int) -> None:
    """追加去掉首尾空白、但仍保留原稿字符位置的片段。"""
    while start < end and draft[start].isspace():
        start += 1
    while end > start and draft[end - 1].isspace():
        end -= 1
    if start < end:
        result.append({"text": draft[start:end], "start": start, "end": end})


def draft_segments(draft: str, max_chars: int = 800) -> list[dict]:
    """按非空行分段；超长单行按句末切开，避免整章被视作一个段落。"""
    result: list[dict] = []
    for line in re.finditer(r"[^\r\n]+", draft):
        start, end = line.span()
        while end - start > max_chars:
            window = draft[start:start + max_chars]
            stops = list(re.finditer(r"[。！？!?；;](?:[”’\"']?)(?=\s|$|.)", window))
            useful = [m.end() for m in stops if m.end() >= max_chars // 2]
            cut = useful[-1] if useful else max_chars
            _append_segment(result, draft, start, start + cut)
            start += cut
        _append_segment(result, draft, start, end)
    if not result and draft.strip():
        start = draft.find(draft.strip())
        _append_segment(result, draft, start, start + len(draft.strip()))
    return result


def _normalized_with_positions(text: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    positions: list[int] = []
    for index, char in enumerate(text):
        if char.isspace():
            continue
        chars.append(char.translate(_QUOTE_TRANSLATION))
        positions.append(index)
    return "".join(chars), positions


def find_source_span(draft: str, source: str, cursor: int = 0) -> tuple[int, int] | None:
    """先逐字、再忽略空白和引号样式定位模型返回的原稿引文。"""
    source = (source or "").strip()
    if not source:
        return None
    start = draft.find(source, max(0, cursor))
    if start < 0:
        start = draft.find(source)
    if start >= 0:
        return start, start + len(source)

    normalized_draft, positions = _normalized_with_positions(draft)
    normalized_source, _ = _normalized_with_positions(source)
    if not normalized_source or not positions:
        return None
    normalized_cursor = sum(1 for pos in positions if pos < max(0, cursor))
    found = normalized_draft.find(normalized_source, normalized_cursor)
    if found < 0:
        found = normalized_draft.find(normalized_source)
    if found < 0:
        return None
    return positions[found], positions[found + len(normalized_source) - 1] + 1
