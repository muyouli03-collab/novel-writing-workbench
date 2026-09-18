"""EPUB 文本抽取:EPUB 本质是 zip + XHTML,用标准库即可可靠抽取正文与书名。

- 依 META-INF/container.xml 定位 OPF,按 <spine> 的阅读顺序取正文(跳过 linear="no" 的封面页)。
- 用 <dc:title> 元数据作为书名(兜底为文件名)。
- 不依赖任何第三方库;MOBI 等专有格式不在本模块范围(建议用 Calibre 转)。
"""
import html as html_mod
import io
import posixpath
import re
import zipfile

# 块级标签(含 <br>)统一替换为换行,再剥离其余标签
_BLOCK = re.compile(r'</?(?:p|div|h[1-6]|li|tr|blockquote|section|article|br)\b[^>]*/?>', re.I)


def _html_to_text(fragment: str) -> str:
    """把一段 XHTML 转成纯文本,每个块级元素一行。"""
    fragment = re.sub(r'<head\b[^>]*>.*?</head>', '', fragment, flags=re.I | re.S)
    fragment = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', '', fragment, flags=re.I | re.S)
    fragment = _BLOCK.sub('\n', fragment)
    fragment = re.sub(r'<[^>]+>', '', fragment)
    fragment = html_mod.unescape(fragment).replace('\xa0', ' ')
    lines = [ln.strip() for ln in fragment.splitlines()]
    return '\n'.join(ln for ln in lines if ln)


def _strip_tags(fragment: str) -> str:
    return html_mod.unescape(re.sub(r'<[^>]+>', '', fragment)).strip()


def extract_epub(raw: bytes):
    """从 EPUB 字节流抽取 (正文文本, 书名)。失败抛 ValueError。"""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"不是有效的 EPUB(zip)文件:{exc}")

    names = set(zf.namelist())

    # 1) 定位 OPF(优先 container.xml,兜底找任意 .opf)
    opf_path = None
    try:
        container = zf.read("META-INF/container.xml").decode("utf-8", "ignore")
    except KeyError:
        container = ""
    m = re.search(r'full-path=["\']([^"\']+)["\']', container)
    if m and m.group(1) in names:
        opf_path = m.group(1)
    if not opf_path:
        for n in names:
            if n.lower().endswith(".opf"):
                opf_path = n
                break

    opf = zf.read(opf_path).decode("utf-8", "ignore") if opf_path else ""

    # 2) 书名(优先 <dc:title>,兜底 <title>)
    title = None
    tm = re.search(r'<dc:title[^>]*>(.*?)</dc:title>', opf, flags=re.I | re.S)
    if tm:
        title = _strip_tags(tm.group(1))
    if not title:
        tm = re.search(r'<title[^>]*>(.*?)</title>', opf, flags=re.I | re.S)
        if tm:
            title = _strip_tags(tm.group(1))

    # 3) 阅读顺序:spine 的 idref → manifest 的 href
    spine_ids = []
    sm = re.search(r'<spine\b.*?</spine>', opf, flags=re.I | re.S)
    if sm:
        for ref in re.finditer(r'<itemref\b([^>]*)/?>', sm.group(0), flags=re.I):
            attrs = ref.group(1)
            if re.search(r'\blinear=["\']no["\']', attrs, flags=re.I):
                continue  # 跳过封面等非正文页
            id_m = re.search(r'\bidref=["\']([^"\']+)["\']', attrs)
            if id_m:
                spine_ids.append(id_m.group(1))

    manifest = {}
    for item in re.finditer(r'<item\b[^>]*/?>', opf, flags=re.I):
        attrs = item.group(0)
        id_m = re.search(r'\bid=["\']([^"\']+)["\']', attrs)
        href_m = re.search(r'\bhref=["\']([^"\']+)["\']', attrs)
        if id_m and href_m:
            manifest[id_m.group(1)] = href_m.group(1)

    opf_dir = posixpath.dirname(opf_path) if opf_path else ""
    ordered = []
    for sid in spine_ids:
        href = manifest.get(sid)
        if not href:
            continue
        p = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
        if p in names:
            ordered.append(p)

    # 兜底:按文件名排序取所有 xhtml/html/htm
    if not ordered:
        for n in sorted(names):
            if n.lower().endswith((".xhtml", ".html", ".htm")):
                ordered.append(n)

    parts = []
    for p in ordered:
        try:
            parts.append(_html_to_text(zf.read(p).decode("utf-8", "ignore")))
        except KeyError:
            continue

    text = "\n".join(parts)
    if not text.strip():
        raise ValueError("EPUB 中未抽取到正文")
    return text, title or ""
