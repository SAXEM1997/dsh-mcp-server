# 文件传输：预签名上传 + 图片读取（设计）

> 2026-11-12 · 对应 issue #4 · 状态：**待评审**

## 1. 问题

`dsh-mcp-btwy` 的 MCP 通道只能传文本。

- **读方向**：协议早就支持 `image` 内容块，客户端（Hermes）收到后会缓存成图片交给模型
  （`/opt/hermes/tools/mcp_tool_handlers.py:495-520`）。本插件从不产出这种块
  （`lib/protocol.js:285-302` 只投影 `text`/`structuredContent`）——能力有，没开。
- **写方向**：MCP 规范里工具入参就是 JSON，客户端没有「把本地文件交给服务器」的通道。
  让模型逐 token 生成 base64 也不现实（85 KiB 图 ≈ 113 KiB base64）。

调研结论（详见 Hermes 仓 `docs/research/2026-11-12-dsh-mcp-attachment-transport.md`）：

| 事实 | 证据 |
|---|---|
| Hermes 无「本地文件 → MCP server」能力，`call_tool` 纯 JSON 透传 | `mcp_tool_handlers.py:449` |
| Hermes 插件市场 763 个，无通用上传插件（全是厂商/平台绑定） | `/opt/hermes/plugin-catalog` |
| MCP 生态传文件三派：路径、base64 参数、**带外预签名上传** | playwright `browser_file_upload{paths}`；MCP Draft `experimental-ext-file-uploads` |

## 2. 目标与非目标

**目标**

1. 任何客户端（哪怕没有我们写的插件）都能把图片送进 DSH 会话，只要它有 shell 或 HTTP 能力。
2. 读方向能返回图片，模型直接看见。
3. 不引入第二套凭据、不要求客户端预装脚本。

**非目标**

- 不传非图片文件（PDF/zip 等）：DSH 的附件服务是图片向的（`saveImages()` 校验 mediaType、
  做尺寸归一化），文件类没有对等入口。
- 不做流式/断点续传。
- 不改 stdio 传输：插件需要进程内的 `sessionController`/`attachments`/`agents`
  （`lib/dsh-delivery.js:76-90`），stdio 拿不到。

**反目标（即使能跑也算失败）**

- 把 bearer token 暴露给模型/命令行（日志泄露）。
- 让上传端点成为无限制的写盘入口（必须限额 + 过期 + 速率上限）。
- 客户端必须改代码才能用。

## 3. 考虑过的方案

| 方案 | 为什么不用 |
|---|---|
| A. 客户端侧插件（读文件→上传→投递） | 确定性最好，但要求每个客户端装代码；作为**后续可选**，不是第一版 |
| B. 在客户端容器放 `dsh-upload` 脚本 + 工具描述引导 | **不通用**：别人的部署里没有这个脚本 |
| C. 带鉴权的上传端点 + 模型 `curl` | 模型看不到 token（它在客户端配置里），vanilla 环境走不通 |
| **D. 预签名能力 URL（选定）** | URL 自带能力，无需凭据、无需预装，与 MCP Draft 同构 |
| E. 共享挂载路径 | 部署特定（要求两侧同卷），不进入通用实现 |

## 4. 选定方案

```
① dsh_prepare_upload({files:[{name?, mediaType, bytes?}]})
     → {uploads:[{fileId, uploadUrl, method:"PUT", expiresAt, maxBytes}]}

② 客户端 PUT 字节到 uploadUrl              ← 不带任何 header 也合法
     200 → {fileId, bytes, sha256, mediaType}

③ dsh_run_prompt(prompt, fileIds:[...])     ← 插件把图片挂进消息 parts
```

读侧：

```
dsh_read_attachment(sessionId, seq, maxEdge?) → content:[{type:"image", data, mimeType}]
```

### 4.1 为什么 URL 里放 nonce 而不是 token

模型/客户端只知道工具返回值。它拿不到 `DSH_MCP_TOKEN`（那是客户端配置里的 header），
所以任何要求 bearer 的上传端点都只能由**代码**调用。nonce 方案把凭据放进 URL：

- 32 字节随机（base64url），不可猜；
- 与铸造它的那次调用绑定：限定大小上限、允许的 mediaType、过期时间；
- 只在响应里出现一次，不进日志（服务端日志只记 hash 前缀）。

## 5. 契约

### 5.1 `dsh_prepare_upload`

入参：

```jsonc
{ "files": [ { "name": "a.jpg", "mediaType": "image/jpeg", "bytes": 85918 } ]  // 1..uploadMaxFiles 项
```

出参：

```jsonc
{ "uploads": [ {
  "fileId": "f_7Kd2…",
  "uploadUrl": "http://dsh:23022/mcp-files/v1.Kd8x…",   // 绝对地址
  "method": "PUT",
  "expiresAt": "2026-11-12T04:52:00.000Z",
  "maxBytes": 20971520
} ] }
```

### 5.2 `PUT <uploadUrl>`

- 请求体 = 原始字节；`content-type` 必须匹配铸造时声明的 `mediaType`（不匹配 415，**槽位不消耗**）。
- 成功 `200`，返回 `{fileId, bytes, sha256, mediaType}`。
- **幂等重试**：首次成功之前，同一 URL 可以重复 PUT（网络中断、超时都不消耗槽位）；
  首次成功后该 URL 立即失效，再 PUT 返回 `409 already uploaded`。
- 超过 `maxBytes` → `413`（槽位不消耗，可用更小的文件重试）。
- 过期 → `410 expired`，客户端应重新 `dsh_prepare_upload`。

> **关于「单次」的含义**：这里的单次是「单次**成功**」。失败重试不消耗槽位——这是对网络
> 抖动、代理超时、客户端中途退出的必要容忍，否则一次超时就得整套重铸。

### 5.3 `dsh_run_prompt(..., fileIds)`

- 新参数 `fileIds?: string[]`，上限同 `uploadMaxFiles`。
- 插件：`attachments.saveImages([{data, mediaType}])` 已经在上传成功时做过；投递时按
  `fileId → attachment ref` 映射拼 parts：`[{type:"text",text}, {type:"image",attachment}, …]`。
- 未知/过期 `fileId` → `404 unknown fileId`（不静默丢图）。

### 5.4 `dsh_read_attachment`

- 入参 `sessionId`、`seq`（事件序号）、可选 `maxEdge`（默认 1568）。
- 实现：从会话事件里取 attachment ref → `attachments.readImageRequest(ref, {longEdge:maxEdge})`
  → 返回 `content:[{type:"image", data:<base64>, mimeType}]`。
- `projectToolOutcome` 增加 `outcome.content` 透传（当前只认 `text`/`structuredContent`）。
- 单次最多 4 张原生附图是**客户端**的上限（Hermes `_MCP_NATIVE_IMAGE_MAX`），服务端不做限制，
  但文档要写明「多张请分次读取」。

### 5.5 配置键

| 键 | 默认 | 夹值 | 说明 |
|---|---|---|---|
| `uploadTtlMs` | 600000（10 min） | 60 s – 24 h | 铸造到首次成功上传的窗口 |
| `uploadMaxFileBytes` | 20 MiB | 64 KiB – 256 MiB | 单文件 |
| `uploadMaxFiles` | 10 | 1 – 20 | 上界受 DSH 消息的 20 张限制约束 |
| `uploadMaxBytes` | 64 MiB | 1 MiB – 512 MiB | 单次 `dsh_prepare_upload` 的总配额 |

夹值在读取时做（照 `maxBodyBytes` 的既有写法，`index.js:547-549`），配置错也扩不出安全区。

### 5.6 上传地址怎么来

`uploadUrl` 的 origin 由**请求本身**推导，不由服务端自报监听地址：

```
origin = clientBaseUrl（若本次调用显式传入）
      ?? X-Forwarded-Proto + X-Forwarded-Host（若存在）
      ?? Host 头
```

请求上下文已经一路传到工具 handler（`lib/http-route.js:198` 构造 `context` →
`lib/protocol.js:242` `callTool(name, args, context)`），只需给 `context` 加 `origin` 字段。

`clientBaseUrl` 只覆盖**本次调用**，不落库；`origin` 同样只在响应里回声，不参与鉴权。

### 5.7 错误码

| 码 | 场景 |
|---|---|
| `400` | multipart 结构坏了 / 缺 `files` |
| `401` | `dsh_prepare_upload` 走 MCP 通道时的常规鉴权失败 |
| `404` | `fileId` 未知或已过期（`dsh_run_prompt`） |
| `409` | 该 nonce 已成功上传过 |
| `410` | nonce 过期 |
| `413` | 超单文件/总配额 |
| `415` | `content-type` 与声明不符 |
| `429` | 速率上限（默认 60 次/分钟，全局） |

## 6. 安全

- nonce：32 字节随机、单次成功、10 分钟过期、绑定声明的 `mediaType` 与 `maxBytes`。
- 速率：全局 60 次铸造/分钟；单次铸造 ≤ `uploadMaxFiles`。
- 存储：字节直接进 DSH 的 content-addressed 附件存储，插件不落第二份。
- 日志：不记录 nonce 原文，只记前缀 + 结果。
- 威胁模型：能连到 MCP 端口的攻击者若猜到 nonce 才能上传——概率可忽略；即使上传成功，
  字节也只在被 `dsh_run_prompt` 引用后才进会话。

## 7. 测试面

| 层 | 用例 |
|---|---|
| 单元 | nonce 生命周期（铸造/成功/重试不消耗/过期/超额/类型不符）；`fileId` 映射 TTL；origin 推导三种来源；multipart 解析（Node 24 的 `Response.formData`） |
| 集成 | 假客户端 `curl -T` 全流程；`dsh_run_prompt` 带 1/3/4 张图；未知 id 报 404 |
| 协议 | 工具数 26 → 28；`initialize` 的 `_meta` 含 `upload` 描述；`tools/list` schema 校验 |
| 文档 | `docs/{zh,en}/tools.md` 新增两节，`check:docs` 通过 |

## 8. 票

| 票 | 内容 | 依赖 |
|---|---|---|
| T1 | `PUT /mcp-files/<nonce>` + nonce 生命周期 + `saveImages` 存储 + 配置键 | — |
| T2 | `dsh_prepare_upload` + `dsh_run_prompt(fileIds)` + `context.origin` + `_meta` 暴露 | T1 |
| T3 | `dsh_read_attachment` + `projectToolOutcome` 透传 `content` | — |
| T4 | 文档（zh/en）+ 版本 1.3.0 + 发布说明 | T1–T3 |

T3 与 T1 可并行。

## 9. 留给实现者的判断

- nonce 的编码格式（不透明串 vs 带版本前缀）——不影响契约。
- 上传字节先在内存聚合还是流式落临时文件——20 MiB 上限下内存聚合更简单。
- `dsh_status` 里是否也暴露一个 `upload` 摘要（我倾向只暴露 `enabled` 与限额，不暴露地址）。
- 速率上限的实现形态（令牌桶 vs 固定窗口）。
