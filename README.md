# 小说创作辅助工作台

面向个人小说创作的本地 Web 工具：从自然语言需求检索参考片段，管理章节与知识卡片，并通过 MCP 向支持工具调用的客户端提供查询入口。

个人实践项目。本人负责需求分析、功能方案、使用测试与迭代验收；代码主要借助 AI 编程工具生成，结合实际创作需求持续修正。

## 核心功能

- **范本检索**：导入 TXT / EPUB，向量召回并保留作品、章节和原文来源；支持快速、精细、深度迭代模式。
- **写作项目**：章节编辑与自动保存、知识条目管理、原稿分析和检索记录持久化。
- **知识画布**：人物、场景、伏笔等卡片的可视化管理、关联、合并与撤销。
- **MCP 查询**：查询卡片、剧情事件与原文片段，支持章节范围；不提供小说内容写入工具。

## 界面预览

以下为实际使用截图，展示知识管理与原稿分析的主要流程。图中数据未随仓库提供；[查看完整功能演示（16 张图，含示例检索与 MCP）](docs/功能演示.md)。

### 从写作需求查找参考片段

使用仓库自带的《雨夜来信》查询等待时的焦虑描写，展示原文高亮、来源、匹配理由和写法建议。

![示例检索结果](docs/images/16-example-result.png)

### 知识卡片与关系画布

按剧情分段浏览卡片及关联，组织长篇作品中的人物、名词与场景。

![知识关系画布](docs/images/05-knowledge-graph.png)

### 剧情事件与原文依据

编辑并人工确认剧情概括，按需展开原文依据和关联伏笔。

![剧情事件索引](docs/images/06-plot-events.png)

### 澄清创作意图

分析前先确认人物性格、叙述视角和描写目标，允许作者纠正模型理解。

![创作意图澄清](docs/images/09-clarification.png)

### 原稿诊断与检索准备

定位需要加强的位置，展示诊断原因、前后场景及可编辑的检索需求。

![薄弱描写诊断](docs/images/11-draft-diagnosis.png)

## 技术与数据流程

Python / FastAPI / NumPy / SQLite / 原生 JavaScript / D3 / BGE-M3 / MCP。

```text
TXT / EPUB → 章节与段落分块 → Embedding → 本地向量索引
自然语言需求 → dense 召回 → 可选 BGE-M3 混合精排 → LLM 精选 → 带来源的参考片段
小说章节 → LLM 整理 + 引文校验 → 知识卡片与剧情事件 → 画布 / MCP 查询
```

混合精排使用 dense、sparse、ColBERT 分数；需要额外依赖、模型权重和可用 CUDA。本公开版示例配置默认关闭该项，可先体验 dense 流程。MCP 卡片/剧情查询采用关键词检索，原文搜索可使用向量检索。

## 安装与运行

基础环境：Python 3.10+；语义检索需要 Ollama 的 `bge-m3` 或在设置中配置兼容的 Embedding 服务。AI 精选和知识整理需要可用的 LLM 端点。仓库不含密钥、模型权重、用户数据库或第三方小说全文。

### 推荐：双击启动

Windows 用户双击 `start.bat`；缺少环境时会自动调用 `setup.bat` 完成准备，也可以直接运行 `setup.bat`。如果通过 `py` 和 `python` 都找不到可用的 Python 3.10+，脚本会打开 Python 官方 Windows 下载页，并提示安装后关闭窗口、重新运行 `setup.bat`；浏览器未打开时可使用窗口显示的地址。传统安装器如提供“Add python.exe to PATH”选项，请勾选。已有可用 Python 时，向导会：

1. 检查 Python，缺少 `.venv` 时自动创建项目独立环境。
2. 缺少基础依赖时自动联网安装 `requirements.txt`，失败时显示错误并停止，可重新运行重试。
3. 缺少 `.env` 时从 `.env.example` 创建，保留已有配置。
4. 自动启动服务，就绪后打开网页。命令行不再询问模型、API 地址或密钥。

在网页“设置”中选择本地或远程模型并保存，也可以暂不配置，先体验正文编辑。启动网页不代表模型已就绪。以后双击 `start.bat` 即可；旧版或损坏的 `.venv` 仍需按下方说明重建。macOS / Linux 可执行 `python3 setup_wizard.py` 准备环境，再用 `.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` 启动。

首次用当前浏览器打开页面，会出现可跳过的 7 步入门引导，依次说明入口、模型设置、导入范本、检索、正文管理与知识库。完成或跳过后不再自动弹出，顶部“入门引导”可重新打开。它只负责讲解和导航，不自动上传文本或触发模型调用。

### 手动安装

也可在 Windows PowerShell、仓库根目录运行：

```powershell
python --version  # 必须为 3.10 或以上
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 仅本地向量模式需要；远程 Embedding API 用户跳过：
ollama pull bge-m3
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开 http://127.0.0.1:8000 ，在设置中填写自己的模型、地址和密钥。完成依赖安装后也可运行 `start.bat`。macOS / Linux 可用 `.venv/bin/python` 替换解释器路径。

### Windows / Anaconda 旧版本报错

如果出现 `TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'`，尤其停在 `dict | None` 等类型注解处，请先检查项目实际解释器：

```powershell
.venv\Scripts\python.exe --version
```

项目要求 Python 3.10 或以上。安装新版 Python 不会自动升级已有 `.venv`；即使系统装了多个版本，`python` 仍可能指向旧 Anaconda。

安装 Python 3.10 及 Windows Python 启动器后，关闭旧服务，在项目目录的 PowerShell 中执行（旧环境改名保留，不删除）：

```powershell
py -3.10 --version
# 确认上一条显示 Python 3.10.x 后再继续；若旧备份名已存在，换一个名字。
Rename-Item -LiteralPath .venv -NewName .venv-old
py -3.10 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe --version
```

已有的 `.env` 与 `data/` 无需删除或重新复制。若 `py` 命令不可用，可用所安装新版 Python 的完整路径创建虚拟环境。确认新环境可用后再自行移除旧环境备份。

`start.bat` 会先检查虚拟环境、Python 最低版本和基础依赖；尚未准备好环境时自动进行初始化，然后在当前窗口运行服务。服务就绪后会自动打开浏览器；若未打开，可手动访问 http://127.0.0.1:8000 。保持服务窗口开启；启动失败时窗口会保留错误信息。

三章演示样例与操作步骤见 [examples/README.md](examples/README.md)。完整 AI 功能不会因为启动页面就自动可用。

## 文档

- [使用指南](使用指南.md)：基础操作与可选 GPU 精排配置。
- [设计方案](设计方案.md)：架构与历史设计记录。
- [MCP 使用说明](MCP使用说明.md)：独立环境和客户端配置。
- [历史检索测试报告](测试报告.md)：三种模式的案例对比、指标摘要及证据边界。
- [公开版验证记录](公开版验证记录.md)：本次验证结果及边界。
- [公开版整理说明](公开版整理说明.md)：收录范围、排除内容及历史报告状态。

## 验证记录

历史检索案例见 [测试报告](测试报告.md)，整理期间的回归验证见 [公开版验证记录](公开版验证记录.md)。公开安装版不包含开发测试脚本。维护者已在朋友的实体电脑和 Windows 虚拟机中验证：安装 Python 后，可以通过 `setup.bat` 完成环境准备并使用。此为维护者反馈，尚未记录各环境的完整版本和逐项功能结果，不等于所有系统、模型与可选 GPU 功能均已验证。

## 目录

```text
app/                     后端、检索、持久化与知识管理
static/                  前端和 D3（附第三方许可证）
examples/                虚构演示文本与步骤
setup.bat / setup_wizard.py  自动准备运行环境
start.bat / launch_web.py 检查并启动服务，就绪后打开网页
novel_mcp.py             MCP 适配器
check_mcp_connection.py   连接检查
data/                    运行时自动创建，不纳入版本管理
```

## 使用边界

这是面向本机单用户的个人项目，尚未按公网多用户服务部署验证。默认仅监听本机地址。使用远程模型时，相关输入与选中的正文片段会发送到配置的模型服务；密钥和运行数据保存在本地并被 Git 忽略。

AI 整理内容需要人工核对原文；示例不构成真实模型质量或性能承诺。硬件、模型和参数会影响效果与耗时。

当前未为原创项目代码指定开源许可证；公开展示与授予开源使用许可是不同事项。第三方 D3 许可证见 `static/vendor/d3.LICENSE.txt`。

### 使用本地或远程兼容向量 API（无需安装 Ollama）

在“设置 → Embedding(向量化)”选择“OpenAI 兼容 Embedding API”，分别填写服务商提供的向量模型名称、API 地址和密钥，保存后上传范本。此配置独立于主 LLM；只配置聊天 API 不能建立向量索引。

地址可以是 `https://服务域名/v1`、服务商指定的其他基础路径，或完整的 `/embeddings` 地址。程序只为基础地址追加 `/embeddings`，不会自动补 `/v1`。本机兼容服务也可手动选择该接口类型。远程 Ollama 原生服务请选择“Ollama 原生接口”。更换向量模型后，旧范本需要重新上传建立索引，知识库需更新向量索引。

状态栏对兼容 API 显示已选择的接口类型，不会要求启动 Ollama，也不会自动发送收费的测试文本。连接是否成功以实际索引或检索结果为准。

“按地址推断”模式不进行网络探测：以 `/v1` 或 `/embeddings` 结尾使用兼容协议，以 `/api/embed` 结尾或无路径的 11434 端口使用 Ollama，其余使用兼容协议。非默认端口的 Ollama 请手动选择接口类型。协议与部署位置无关，本地 BGE 服务只要提供支持的向量接口即可接入；模型 ID 和密钥以该服务配置为准。
