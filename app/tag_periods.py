"""Chapter ranges for user-defined tags; stored alongside the existing tag names."""


def periods_for(details):
    result = []
    for tag in details.get("tags") or []:
        rows = [r for r in details.get("tag_periods") or [] if isinstance(r, dict) and r.get("tag") == tag]
        result.extend(rows or [{"tag": tag, "valid_from_chapter_id": "", "invalid_from_chapter_id": ""}])
    return result


def validate_periods(values, tags, chapters):
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError("细分时间必须是列表，每张卡片最多保存100段时间")
    canonical = {tag.casefold(): tag for tag in tags}
    result = []
    for row in values:
        if not isinstance(row, dict) or not isinstance(row.get("tag"), str):
            raise ValueError("细分时间格式无效")
        tag = canonical.get(row["tag"].strip().casefold())
        if not tag:
            raise ValueError("细分时间必须属于本卡片已选择的标签")
        start, end = (str(row.get(key) or "").strip() for key in ("valid_from_chapter_id", "invalid_from_chapter_id"))
        if any(cid and cid not in chapters for cid in (start, end)):
            raise ValueError(f"细分“{tag}”的章节不存在，请刷新章节目录后重新选择")
        if start and end and chapters[end]["position"] <= chapters[start]["position"]:
            raise ValueError(f"细分“{tag}”的失效章节必须晚于起始章节")
        cleaned = {"tag": tag, "valid_from_chapter_id": start, "invalid_from_chapter_id": end}
        if cleaned not in result:
            result.append(cleaned)
    return result


def decorate_periods(details, chapters, at_order=None):
    at_order = max((c["position"] for c in chapters.values()), default=0) if at_order is None else at_order
    result = []
    for row in periods_for(details):
        start, end = row.get("valid_from_chapter_id", ""), row.get("invalid_from_chapter_id", "")
        invalid = any(cid and cid not in chapters for cid in (start, end))
        reversed_range = start in chapters and end in chapters and chapters[end]["position"] <= chapters[start]["position"]
        status = ("unknown" if invalid or reversed_range else
                  "pending" if start in chapters and chapters[start]["position"] > at_order else
                  "ended" if end in chapters and chapters[end]["position"] <= at_order else "active")
        result.append({**row, "temporal_status": status,
                       "valid_from_chapter": chapters.get(start), "invalid_from_chapter": chapters.get(end)})
    return result
