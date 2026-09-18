"""只读连接自检：不打印卡片内容或调用模型。用.venv-mcp运行。"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def value(result):
    if result.isError:
        raise RuntimeError("；".join(c.text for c in result.content if c.type == "text"))
    if result.structuredContent is not None:
        return result.structuredContent
    return json.loads(next(c.text for c in result.content if c.type == "text"))


async def check(api_url):
    params = StdioServerParameters(command=sys.executable, args=["-X", "utf8",
        str(Path(__file__).with_name("novel_mcp.py")), "--api-url", api_url])
    with anyio.fail_after(45):
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
                assert {t.name for t in tools} == {"list_novels", "select_novel", "search_knowledge_cards", "get_knowledge_card", "search_plot_events", "get_plot_event", "search_original_text", "get_original_excerpt"}
                print("MCP连接成功，已发现8个工具（仅选择查询范围及读取资料）。")
                novels = value(await session.call_tool("list_novels", {}))["novels"]
                print(f"后端连接成功，发现{len(novels)}本小说。")
                if novels:
                    chosen = value(await session.call_tool("select_novel", {"project_id": novels[0]["id"]}))
                    assert chosen["status"] == "selected"
                    print("已从返回的小说列表选择测试查询范围。")
                    result = value(await session.call_tool("search_knowledge_cards", {"limit": 1}))
                    print(f"卡片查询成功，该项目共有{result['total']}张卡片。")
                    if result["results"]:
                        value(await session.call_tool("get_knowledge_card", {"card_id": result["results"][0]["id"]}))
                        print("卡片详情读取成功。")
                    plots = value(await session.call_tool("search_plot_events", {"limit": 1}))
                    print(f"剧情查询成功，该项目共有{plots['total']}条剧情事件。")
                    if plots["results"]:
                        value(await session.call_tool("get_plot_event", {"plot_id": plots["results"][0]["id"]}))
                        print("剧情详情读取成功。")
                print("检查完成，未修改任何卡片。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    try:
        asyncio.run(check(args.api_url))
    except Exception as exc:
        print(f"连接检查失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
