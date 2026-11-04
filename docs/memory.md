# Local Pi 自动记忆

全局与每个项目各有一个 `MEMORY.md`，它是记忆正文的唯一来源，可以直接查看和编辑。使用 `mem0ai@3.3.1` 的开源 Node SDK（`mem0ai/oss`）和 SQLite 建立可重建的检索索引；任务队列、去重回执与删除墓碑仍由 SQLite 保存。没有 Mem0 云账号要求，也不需要部署向量数据库或知识图谱。

## 范围与边界

- 全局记忆：所有项目共享。
- 项目记忆：同一项目所有会话共享，子目录共用最近的 Git/SVN 项目根目录；没有仓库标记时以启动工作目录作为项目。
- Git worktree 暂按不同项目目录处理。目录移动后项目身份会变化，目前没有自动迁移。
- 会话仅作为记忆来源，不建立会话记忆库。
- 配置并启用后会批量自动提取新对话；也可用 `/memory add` 手动补充。自动记忆不会改写 AGENTS.md。
- 每次普通用户提问前重新读取全局和项目 MD。合计不超过 12 条、正文及 ID 等序列化内容不超过 5000 字符时直接提供全部正文，不调用向量模型；超过预算时同步索引，再检索全局、项目各最多 3 条，总注入约 6000 字符。记忆是待核实的数据，不得覆盖当前指令、规则或权限。
- 讨论模式同样可以通过用户明确输入的 `/memory add` 管理助手自身的记忆；不会因此开放项目写入或终端工具。
- 删除后未来提问不再从记忆库召回该记录，但旧对话、旧提示和压缩摘要中的内容不会被追溯改写。

## Markdown 正文、迁移与手动编辑

默认路径（`/memory status` 显示当前实际路径）：

```text
<agent-dir>/local-pi-memory/global/MEMORY.md
<agent-dir>/local-pi-memory/projects/<项目路径哈希>/MEMORY.md
```

项目文件存放在助手配置目录内，不写入业务仓库。第一次对某范围执行读取或管理操作时，将旧库完整导出为 MD，保留原 ID 和来源，另存 `legacy-before-markdown.json`。不会只导出列表页面的前 100 条；超过 10000 条自动迁移上限会拒绝截断。其他项目首次使用时分别迁移。

之后以 MD 为准，不把数据库的新内容反向覆盖文件。文件修改、条目删除和文件清空会在下一次操作时重新读取；不常驻扫描整个项目。文件删除后视为该范围已清空，不会从旧数据库复活。向量索引在搜索或后续写入时增量同步；`/memory reindex project|global` 可从 MD 重建当前模型的索引，正文和来源不变。旧版 local-pi 进程直接写入的未知数据库记录会阻止索引清理，避免误删；升级时请重启全部 local-pi 进程。

文件正文是普通 Markdown。生成文件用隐藏的 `local-pi-entry` HTML 注释保存 ID、来源及版本信息；编辑时修改注释下面的正文，删除时移除相应注释及正文块。新增建议使用 `/memory add`，保持独立条目；从零手写的纯 Markdown 文件也可以按空行分段导入。每条正文最多 4000 字符，文件最多 8MiB；损坏标记、重复 ID、无效 UTF-8、符号链接或硬链接不会被自动覆盖。

同一范围的程序写入复用跨进程锁；向量写入准备完成后，核对 MD 原始字节，再用同目录临时文件发布正文。准备期间发生手动编辑会拒绝覆盖，下一次检索修复未提交的索引。普通编辑器不参与程序锁，发布边界不能提供数据库事务式的外部编辑隔离，请避免在程序正在写入时同时保存该文件。每次程序写入保留被替换版本为 `memory-backup-<内容哈希>.md`，目前不自动清理这些备份；备份可能保留已删除的旧正文，但不会参与召回。

删除、替换或手动移除的旧内容会留下墓碑，阻止旧批次自动重新添加。MD 是正文源，队列、回执、墓碑和迁移记录则属于运行状态，备份时应一起保留整个记忆目录。

## 自动提取细节

每个会话独立累计新内容，绝不拼接两个会话的讨论来凑数量；提取结果只进入全局、项目库。会话中的用户输入计为一轮，工具调用、流式片段和系统通知不另计。

默认任意条件满足时在后台安排提取：

- 同一会话新增 20 个用户轮次；
- 待处理内容约 8000 Token（字符估算，不是服务商账单统计）；
- 有待处理内容且空闲约 10 分钟。每 15 秒检查一次，运行中的会话不按空闲处理。

每轮结束只做采集、计数和阈值检查，不等于每轮都调用模型。切换显示中的会话不触发、不打断任务。关闭、退出、重载时封存剩余批次，保留在磁盘；下次启动从原项目位置恢复。其他项目启动时也会尝试处理以前封存的批次，前提是原项目路径存在、原模型配置仍可用。没有进程运行期间不执行模型请求。

首次启用只把当前已有历史作为边界，不批量回填旧聊天。运行期间崩溃后，恢复同一会话时可补采边界之后已保存的新消息。分叉沿用的历史通过来源指纹去重。会话树切换会建立新边界，避免把旧分支当成新对话回填。

自动采集只保留经过长度限制、脱敏的用户和助手公开文字，以及成功验证命令的少量元数据；不采集思考内容、图片、完整工具输出和整段代码。脱敏是启发式处理，不是任意格式秘密的识别保证，请勿把密钥当作聊天内容。每条自动记忆需要引用本批用户原话或验证记录，助手自述不能独立作为证据。无长期信息时可完成批次而不新增记忆。

同项目按批次顺序处理；失败批次不会被后来的批次越过。自动失败最多尝试 3 次，间隔约 30 秒、60 秒，然后等待 `/memory retry`。后台任务有 60 秒截止时间；云 Embedding 请求默认 4 秒，本地 Ollama 请求连同排队默认最多 60 秒。已经发出的单次存储写入有独立超时，可能在后台截止后完成；重试会用操作标识确认结果，不重复提交同一事实。

精确去重使用规范化内容哈希；语义去重由模型结合相关旧记忆判断，不能保证任意改写都能识别。替换使用版本比对，较旧证据不能覆盖新结论；删除和替换留下内容墓碑，阻止相同旧内容被自动重建。全局新增必须有用户明确跨项目表达，否则降为项目范围。自动删除仅接受用户明确要求忘记记忆的原话。

完成批次后清理其完整输入和提取计划，只留少量跨批上下文尾部及处理标记；队列不是另一份完整会话历史。未完成的批次保留输入用于恢复。

## 配置 Embedding

默认未启用，不加载 Mem0、不建库、不发送记忆模型请求。

需要区分两个模型：**提取模型**从聊天整理事实，复用已有 Pi 套餐；**Embedding 模型**负责向量化，Mem0 的保存和语义检索需要它。Embedding 不是文档切片，不要求建设知识库。它可以来自云接口，也可以是本地兼容服务；没有配置时不会自动下载模型或调用未知服务。

复制仓库的 `examples/local-pi-memory.json` 到 Pi 配置目录的 `local-pi-memory.json`，默认位置：

```text
C:\Users\essence\.pi\agent\local-pi-memory.json
```

使用 `--agent-dir` 或 `PI_CODING_AGENT_DIR` 时，以 `/memory status` 显示的位置为准。

填写 OpenAI-compatible Embedding 的地址、模型名、实际向量维数及密钥环境变量名称。示例中的地址、模型和 1536 维只是占位示例，必须根据服务商填写。不要使用仅支持聊天的套餐地址代替向量接口。

在启动 local-pi 的 PowerShell 中设置密钥（不要把实际密钥写入项目或聊天）：

```powershell
$env:LOCAL_PI_EMBEDDING_API_KEY = '<你的 Embedding 密钥>'
local-pi
```

配置每次操作重新读取；首次运行时会加载 Mem0。密钥、Embedding 配置或数据模型改变后建议重启。已有库不允许直接换 Embedding 模型、地址或维数，需另行迁移。可用 `"enabled": false` 暂停召回和操作。

自动提取复用 Pi 官方 `modelRegistry.streamSimple()`，沿用批次封存时会话的模型和认证，不复制套餐密钥，也不向编码会话追加消息或工具。提取后的结构化事实经过范围、证据检查，更新 MD 及 Mem0 索引；索引使用 `infer: false`，避免第二次提取模型请求。后台请求有独立消耗，不计入当前编码任务的 SDK 会话用量。

示例配置中的 `automatic` 可以调整：

```json
"automatic": {
  "enabled": true,
  "turnThreshold": 20,
  "tokenThreshold": 8000,
  "idleMinutes": 10
}
```

可另设 `"model": "provider/model-id"` 指定 Pi 已配置的提取模型，重试时也会采用这一显式覆盖。省略则沿用原会话模型。`automatic.enabled` 是总开关，设为 false 仍可手动管理和召回已有记忆。`/memory auto off` 只暂停当前项目，暂停期间新对话不补采；已有待处理批次保留。总开关关闭时需先编辑配置重新开启，再使用项目开关。

## 本地 Ollama / Qwen3

安装并启动 Ollama，下载 `qwen3-embedding:0.6b` 后，可使用 `examples/local-pi-memory.ollama.json` 作为配置。`provider: "ollama"` 使用原生 `/api/embed` 接口，`baseURL` 可保留 `http://127.0.0.1:11434/v1`；适配器会转换路径。此模式不读取密钥，`apiKeyEnv` 保留用于配置结构兼容，无需设置环境变量。模型默认输出 1024 维；示例使用该维数，并显式请求和检查维数。

Qwen3 的搜索输入添加英文任务说明和 `Query:`，保存及更新仍使用记忆正文。可通过 `embedding.queryInstruction` 自定义检索说明（空字符串关闭）；这个设置参与库指纹，更改后需要迁移。不要给所有正文统一添加查询指令。

所有会话共用 Ollama 的模型服务；同一 agent-dir 内还按接口地址设置跨进程 FIFO，默认一个向量请求执行。每次请求使用 4 个 CPU 线程选项、4096 上下文、不静默截断、5 分钟驻留；实际 GPU 调度由 Ollama 决定。超过上下文返回错误，不能把“支持 32K”当作当前加载上下文。`embedding.timeoutMs` 可以设置 100–120000 毫秒，Ollama 默认 60000；计时包含排队及模型加载，不自动重试。云接口维持默认 4000 毫秒。超时后客户端释放锁，服务端计算是否立即停止取决于 Ollama。

首次加载可能需要十几秒；发送提问后状态栏显示“记忆：等待向量模型／检索中…”。服务离线或超时则提示召回失败，继续原有编码流程。需要服务正常运行才能使用本地记忆，不自动安装、启动或切换到云模型。

验证本机模型可运行（仅临时测试库，不使用真实套餐提取模型）：

```powershell
$env:LOCAL_PI_TEST_OLLAMA = '1'
node --test test/ollama-memory.test.ts
Remove-Item Env:LOCAL_PI_TEST_OLLAMA
```

官方参考：[Ollama Embedding API](https://docs.ollama.com/api/embed)、[Qwen3 查询指令](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)。

## 使用

```text
/memory
/memory status
/memory add project 旧接口仍被小程序调用，暂时保留
/memory add global 最终说明使用中文
/memory list project
/memory list global
/memory search project 旧接口
/memory used
/memory reindex project
/memory delete project <完整记忆 ID>
/memory edit project <完整记忆 ID> 修改后的内容
/memory auto off
/memory auto on
/memory extract
/memory retry
```

`/memory` 打开有边框、可滚动的帮助页。查询结果及状态使用同样的只读页，Esc 关闭；页面不进入模型对话历史。全局手动添加，以及手动修改、删除，需要界面确认。`/memory status` 展示阈值、待处理量、运行／失败任务及最近结果；`/memory used` 显示最近一轮检索结果。列表最多显示 100 条，完整分页留待后续实现。`extract` 只封存当前项目的待处理内容并安排后台执行，不导入旧历史；后台全局扫描仍可恢复其他项目已经排队的任务。

## 存储与并发

```text
<agent-dir>/local-pi-memory/
  global/
    MEMORY.md              # 正式记忆正文
    vectors.sqlite
    history.sqlite
    embedding.json
    control.sqlite          # 去重回执和删除／替换墓碑
  projects/<项目路径哈希>/
    MEMORY.md              # 当前项目的正式正文
    vectors.sqlite
    history.sqlite
    embedding.json
    control.sqlite
  automatic.sqlite          # 增量边界、批次、任务及项目开关
  inference/                # Ollama 接口共享队列及跨进程协调
  workspace-coordination/   # 复用 Local Pi 的跨进程锁
```

全局与项目使用独立文件和数据库。查询、删除都限定在选定范围，不接受模型自选目录。并发操作通过程序锁协调；Embedding 客户端请求超时后释放锁。同一安装配置目录内的多个进程也使用同一协调目录。Embedding 请求不自动重试；短记忆无需向量请求，其他失败提示后继续原有编程流程。

Mem0 遥测在首次加载前关闭。源码与 npm 包对默认存储的文档存在差异；本实现锁定并针对发布的 3.3.1 测试 SQLite 和超时适配，不依赖包名为 `memory` 就推测其是否持久化。

Mem0 的 SQLite 依赖 `better-sqlite3` 需要匹配 Node ABI 的原生模块。本机 Node 25 / Windows x64 已使用该依赖官方发布的预编译文件验证。全新安装时，`npm ci --ignore-scripts` 后还需 `npm rebuild better-sqlite3`；下载失败时需要能访问官方发布资源，或具备 C++ 编译工具链。不要复制不同 Node 版本的原生模块。

## 验证

`node --test test/memory.test.ts test/memory-queue.test.ts test/automatic-memory.test.ts` 使用本地模拟模型和 Embedding 服务验证真实 Pi 认证链及 Mem0，不调用付费服务。覆盖阈值、空闲、关闭／启动恢复、分叉去重、来源校验、项目隔离、持久化、部分保存重试、版本冲突、关闭取消及原有工具权限。

官方参考：[Node SDK](https://docs.mem0.ai/open-source/node-quickstart)、[SDK 配置](https://docs.mem0.ai/open-source/configuration)、[Pi 扩展](https://pi.dev/docs/latest/extensions)。

## 依赖审计

本轮通过定向覆盖 `@aws-sdk/xml-builder` 使用的 `fast-xml-parser` 消除了新增依赖链中的严重告警。当前 `npm audit` 仍报告 6 个包级告警（2 中、4 高），涉及旧版 Pi SDK 的 minimatch/undici，以及 Mem0/OpenAI 的 Zod 依赖链；不代表发现 6 个互相独立的运行漏洞。本轮没有强制切换上游主版本。记忆默认关闭，后续应跟进兼容版本升级，不能把测试通过等同于依赖审计无问题。
