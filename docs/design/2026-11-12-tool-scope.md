# 工具作用域（全局 / 按工作区）设计

> 2026-11-12。让本插件暴露给 DSH 的工具可以「全局可见」或「只在选定的工作区可见」，
> 使不需要控制面工作区不为 28 个工具的 schema 付上下文成本。
>
> 调研见 `docs/research/2026-11-12-tool-scope-survey.md`（对照 `dsh-cherry-bridge` 的实现）。

## 1. 目标与非目标

**目标**

- 两种模式：`global`（默认，行为与今天完全一致）、`selected`（只有列出的工作区可见）。
- 设置页可切换模式、勾选工作区、保存后立即生效（不重启）。
- 判定失败一律收紧（看不见），绝不因为读不出配置而放大可见性。

**非目标**

- 不做 MCP 客户端（外部连接）侧的过滤——那是另一套语义，见 D5。
- 不做按工具分组（tool groups）的勾选，只做「整个面开/关」。
- 不做按 agent preset、按会话、按时间的开关。

## 2. 数据模型

配置写在插件那一行的 `cordis.patch.yml` 里（与其它设置同源，经 `configEditor` 保存）：

```yaml
- id: dsh-mcp-server
  config:
    toolScope:
      mode: selected        # global | selected
      workspaceIds: [ws_ab12, ws_cd34]
```

- `mode` 缺省 → `global`（**D1**：升级不改变既有行为）。
- `workspaceIds`：去重、按字符串升序、去掉首尾空白后的不透明 id。
- **规范化在读取时做，不写回**：写回只发生在用户保存时。

**失败矩阵（全部收紧到 `selected + []`）**

| 情况 | 判定 |
|---|---|
| `toolScope` 缺失 | `global`（D1） |
| `mode` 不是两个值之一 | `selected + []` + `scope-degraded` |
| `mode: selected` 但 `workspaceIds` 不是数组 | `selected + []` + `scope-degraded` |
| 数组里有非字符串 | 丢弃该条；全被丢弃 ⇒ `selected + []` + `scope-degraded` |
| Host 没有 `workspaceRegistry` | `selected + []` + `scope-unsupported`（页面显示原因） |

`scope-degraded` / `scope-unsupported` 都出现在 `dsh_status.scope.notes[]` 与页面顶部，**不静默**。

## 3. 判定与执行期强制

### 3.1 工作区解析

`agent.cwd` → `ctx.get('workspaceRegistry').resolveByPath(cwd)` → `{ id }`。

- 按 `cwd` 缓存（Map，命中即用）；`resolveByPath` 是异步的，**不阻塞建会话**：首次未命中先判「不可见」，
  解析完成后下一次 `resolve()` 生效。
- 解析不到工作区（cwd 不在任何已注册工作区里）⇒ 不可见。
- 只在 `mode: selected` 时才做解析；`global` 直接返回可见（零成本）。

### 3.2 判定

```js
visible(agent) = mode === 'global'
               ? true
               : agentWorkspaceId(agent) !== undefined
                 && workspaceIds.includes(agentWorkspaceId(agent))   // 精确相等（D3）
```

**精确相等**，不做前缀/子目录匹配：工作区 id 本身已经是一个根，前缀匹配会让
`repo-old` 与 `repo` 互相污染，而用户真正想要的是「这个工作区」而不是「这个目录树」。

### 3.3 三个强制点

| 位置 | 做法 |
|---|---|
| `full` 模式注册的 28 个定义 | `tools.register(def, { when: (ctx) => allowed(ctx.agent) })` |
| `lazy` 模式的 3 个前门工具 | 同上 |
| `dsh_mcp_open` 往 agent 作用域具名注册的工具 | 注册时也带同一个 `when`，并在 `openFor()` 入口先挡一次 |

- `when` 由 DSH 在每次 `resolve()` 里逐工具 `await`（`dsh-tools/lib/index.js:543-556`），
  返回假值就从**声明与派发**同时拿掉。
- 判据内部 `try/catch` 兜底：抛错一律当 `false`。**不能**让异常冒出去变成
  `ToolActivationError`——那会让整个工具批次失败。
- 已经被 `dsh_mcp_open` 打开过的工具：`when` 在每次 resolve 重新评估，所以切换作用域后
  下一次就生效，不需要撤销注册。

### 3.4 缓存

判定结果按 `agent.id`+`cwd` 缓存；失效时机：配置重载（插件重建）、`workspaceRegistry` 变更事件（若可用）。
判定本身是 O(1)（一次 Map 命中 + 一次数组 `includes`），28 个工具每步各一次也在微秒级。

## 4. HTTP 契约

新增只读/可写路由 `/mcp-scope`，与 `/mcp-config` 同一套 loopback + Origin 白名单 + JSON 校验。

```
GET /mcp-scope
200 {
  supported: true,
  mode: "global" | "selected",
  workspaceIds: ["ws_ab12"],
  notes: [],                                  // scope-degraded / scope-unsupported
  workspaces: [{ id, title, path, visible }]  // 来自 workspaceRegistry.list()
}

PUT /mcp-scope
body: { mode: "global" | "selected", workspaceIds: ["ws_ab12"] }
200 → 保存后的同一份 GET 形状
```

校验：

- `mode` 必须是两个值之一 → 否则 `400 invalid-mode`。
- `workspaceIds` 必须是字符串数组；**每个 id 必须存在于 `workspaceRegistry`** → 否则
  `400 unknown-workspace` 并回显未知项（防止手写错 id 变成静默不可见）。
- `mode: global` 时忽略 `workspaceIds`（保存仍写回，方便来回切换）。
- Host 无 `workspaceRegistry` → `501 scope-unsupported`，页面显示「当前 Harness 不提供工作区注册表」。

保存走 `configEditor.edit(entry, current => ({...current, toolScope: {mode, workspaceIds}}))`，
与现有设置同一条路；写完后插件重载，判定立即生效。

**不做 `revision` 乐观并发**：这是单机单页面的开关，不是多人编辑的文档；cherry 需要 revision
是因为它把作用域文档当共享资源存盘，我们不存盘。

## 5. 页面

在现有 `/mcp-config` 页加一节「工具作用域」，复用宿主原语：

```
┌ 工具作用域 ────────────────────────────────┐
│ 可见范围   [ 全局 ] [ 仅选定工作区 ]        │   ← ui.SegmentedControl
│                                            │
│ 工作区                                     │
│   repo/hermes        [ ● ]                 │   ← ui.Switch（mode=global 时禁用）
│   workspace/twin     [ ○ ]                 │
│   （未注册的 cwd 一律不可见）               │
│                                            │
│ ⚠ 当前配置有一项读不出来，已收紧为「谁都不给」│   ← notes 非空时显示
│                                  [ 保存 ]  │
└────────────────────────────────────────────┘
```

- 保存后用现有的 `RELOAD_SETTLE_MS` 重新读一次，展示实际生效状态。
- `supported: false` 时整节只显示原因，不给可点的控件。
- 工作区很多时滚动；不提供搜索（工作区通常 < 20）。

## 6. `dsh_status` 暴露

```js
scope: {
  mode: 'global' | 'selected',
  workspaceIds: [...],
  workspacesKnown: 12,
  notes: ['scope-degraded'],
}
```

不含 per-agent 明细（那是每次查询都在变的运行时信息）。

## 7. 错误码

| 状态 | code | 场景 |
|---|---|---|
| 400 | `invalid-body` | 不是 JSON 对象 |
| 400 | `invalid-mode` | mode 不是两个值之一 |
| 400 | `unknown-workspace` | workspaceIds 里有注册表里没有的 id（回显） |
| 405 | — | 非 GET/PUT |
| 501 | `scope-unsupported` | Host 无 `workspaceRegistry` |
| 403 | — | 非 loopback / Origin 不在白名单（沿用现有） |

## 8. 测试计划

| 层面 | 用例 |
|---|---|
| 判定 | global 恒可见；selected 命中；selected 未命中；cwd 解析不到；`mode` 非法 → 收紧；`workspaceIds` 非数组 → 收紧；含非字符串 → 丢弃后收紧 |
| 强制 | 可见时 `when` 返回 true；不可见 false；判据抛错 → false（不冒泡）；`openFor` 对不可见工作区拒绝并给出原因；切换作用域后下一次 resolve 生效 |
| HTTP | GET 形状；PUT 保存并回读；`invalid-mode`；`unknown-workspace` 回显；非 loopback 403 |
| 页面 | 至少一条渲染冒烟（有 registry / 无 registry） |
| 回归 | `global` 模式下 28 个工具全部可见（向后兼容） |

## 9. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 缺省 `global` | 升级不改变既有行为 |
| D2 | 用工作区 **id**，不用路径 | 有设置页可以列出来勾选；路径要做 realpath/大小写/尾斜杠规范化，容易错 |
| D3 | **精确相等**，不做前缀 | 工作区 id 已是根；前缀会让 `repo-old` 与 `repo` 互相污染 |
| D4 | 做设置页 | 用户明确要求 |
| D5 | 不做 MCP 客户端侧过滤 | 外部客户端没有工作区概念；要省它的 token 应走客户端自己的工具白名单 |

## 10. 待确认

- 第 2 条答复我理解为「用 id，靠设置页来选」——若你其实想要在 YAML 里直接写路径，请纠正。
