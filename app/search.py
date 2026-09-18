"""余弦相似度检索与句子切分(纯 numpy,毫秒级)。"""
import re

import numpy as np

_SENT_END = re.compile(r"[。！？!?…；;]")


def cosine_topk(query_vec, matrix, top_k: int):
    q = np.asarray(query_vec, dtype=np.float32)
    q = q / (np.linalg.norm(q) + 1e-9)
    m = matrix.astype(np.float32)
    m = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)
    sims = m @ q
    top_k = min(int(top_k), len(sims))
    if top_k <= 0:
        return []
    idx = np.argpartition(-sims, top_k - 1)[:top_k]
    idx = idx[np.argsort(-sims[idx])]
    return [(int(i), float(sims[i])) for i in idx]


def cosine_sims(query_vec, matrix):
    """返回 query 与 matrix 每一行的余弦相似度列表。"""
    q = np.asarray(query_vec, dtype=np.float32)
    q = q / (np.linalg.norm(q) + 1e-9)
    m = matrix.astype(np.float32)
    m = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)
    return (m @ q).tolist()


def sentence_spans(text: str):
    """把文本按行、再按句末标点切成句子,返回 [(start, end, sentence)] 字符偏移。

    偏移量与原文一一对应,供前端做 <mark> 高亮。
    """
    spans = []
    pos = 0
    for line in text.split("\n"):
        start = 0
        for m in _SENT_END.finditer(line):
            seg = line[start:m.end()]
            if seg.strip():
                spans.append((pos + start, pos + m.end(), seg))
            start = m.end()
        tail = line[start:]
        if tail.strip():
            spans.append((pos + start, pos + len(line), tail))
        pos += len(line) + 1
    return spans
