# 按工作区开关工具：调研与方案

> 2026-11-12。目标：像 `dsh-cherry-bridge` 那样，支持「全局启用」或「只在选定的工作区启用」本插件的工具，
> 让不需要这套工具的工作区不为它们的 schema 付上下文成本。

## 1. 为什么值得做（实测，不是估计）

在 DSH 进程里直接量 `lib/capabilities/definitions.js` 的 28 个工具定义：

| 暴露方式 | 工具数 | schema 字节 | ≈ token |
|---|---|---|---|
| `exposeToDshMode: "full"` | 28 | 31,134 | **≈ 9,700** |
| `exposeToDshMode: "lazy"`（默认） | 3（`dsh_mcp_tools`/`dsh_mcp_open`/`dsh_mcp_call`） | 2,591 | ≈ 810 |

也就是说 `full` 模式下，每个会话开局就背 9.7K token 的工具说明；一个只会改前端样式的
工作区，为 `dsh_schedule_edit`、`dsh_read_session` 这些从不使用的工具付同样的钱。
最大的五个：`dsh_schedule_create` 2,737 B、`dsh_read_session` 2,644 B、`dsh_list_sessions` 2,421 B、
`dsh_schedule_edit` 2,169 B、`dsh_run_prompt` 1,940 B。

`lazy` 模式只有 810 token，所以这个特性的真正受益者是开着 `full` 的部署，
以及「同一部署里有的工作区要控制面、有的不要」的场景。

## 2. `dsh-cherry-bridge` 怎么做的

它管 15 个 `cherry_*` 工具，共 2,169 行（两个模块），分五块：

### 2.1 作用域文档（`src/toolScope.ts`）

```ts
interface ScopeDoc { version: number; revision: number; updatedAt?: string
                     mode: 'global' | 'selected'; workspaceIds: string[] }
```

- 磁盘上一份、内存里权威；`save()` 走 validate → prune → revision+1 → 原子写 → 交换，
  **全程没有一个 `await`**，所以 HTTP 的临界区不会被打断（`toolScope.ts:1-40` 的模块注释写死了这条）。
- **失败即收紧（fail-closed）**：读不出来/解析失败/类型不对 ⇒ 落到 `selected + []`（谁都不给），
  永不落回 `global`。严格度顺序 `selected+[]` > `selected+[W]` > `global`。
- 版本号不认识 ⇒ **只读降级**：不覆盖、不回退、单独一条 note 和一个稳定的拒绝码；
  这和「类型非法」是两条路，因为补救方式不同。

### 2.2 判定（`toolScope.ts:229`）

```ts
isVisible(doc, workspaceId) = doc.mode === 'global' ? true
                            : workspaceId !== undefined && doc.workspaceIds.includes(normalize(workspaceId))
```

一个 agent 的判定只有这一处产出，**不从 `status`、不从列表健康度、不从 cwd 是否存在去推**。

### 2.3 工作区解析（`src/toolScopeHost.ts:163`）

```ts
interface WorkspaceRegistryLike { list(): unknown; resolveByPath?(path): Promise<unknown|undefined> }
```

`agent.cwd → workspaceRegistry.resolveByPath()` → workspace 记录 → id。**只读缓存**：
`agent/created` 时若缓存未命中，直接按「不可见」处理（fail-closed），绝不 `await` 阻塞建会话。

### 2.4 执行期强制（`toolScopeHost.ts:248`）

每个 agent 的 scope 上装一层 `agent.ctx.tools.restrict({ deny: [...] })`，层随 agent 释放。
DSH 的 `restrict()` **只接受 scoped context**（`dsh-tools/lib/index.js:451`：

> `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent`），
所以它必须先拿到「有哪些活着的 agent」，再逐个装层。

### 2.5 刷新机制

`agent/created` / `agent/disposed` / 配置保存三类触发器 → 合并去重（running/dirty 闸门）→
每 agent 最多两次有界复核（"exactly two timers, then silence"）。
`guard` 在调用时**只读已装层记录**（层在 ⇒ 拒），从不重算判定。

### 2.6 对外面

HTTP API（读写文档，带 `revision` 乐观并发）+ 设置页 UI（列工作区、全局/选中切换）。

## 3. DSH 侧可用的两个杠杆（我们真正要选的）

### 杠杆一：`tools.register(definition, { when })` —— 每步判定

`@deepseek-ai/dsh-tools/lib/index.js:436-443` 注册时接受 `when`，`:543-556` 在 `resolve(context)` 里
**逐工具、逐次 `await registration.when(context)`**，返回假值就从这一步的声明与派发里一起拿掉。
`context` 里带 `agent` 与 `signal`。

- 优点：**根作用域就能用**，不需要 agent 生命周期、不需要按 agent 装层、不需要 disposer 管理。
- 代价：每次 `resolve` 会对 N 个工具各调一次（可缓存判定，按 agent 记）；`when` 抛错会变成
  `ToolActivationError`，所以**判据内部必须自己 catch**。
- cherry 只在它自己的 subagent 工具上用了这个（`src/index.ts:1192-1201` 的注释写明：
  `restrict` 不是所有宿主都有，`when` 是「不需要额外宿主能力」的那道闸）。

### 杠杆二：`tools.restrict({ allow | deny })` —— 按 agent 装层

`dsh-tools/lib/index.js:451-470`：必须 scoped context，名字必须是已知的全局工具，
返回精确的解除函数；多层取交集。

- 优点：语义强（声明与派发都被遮住），一次装层长期生效，不用每步判。
- 代价：要自己维护「活着的 agent 集合」（`agents` 服务 + `agent/created`/`agent/disposed`）、
  配置变更后要对每个 agent 重装/解除、agent 派生的子 agent 也要覆盖。cherry 那 1,091 行大部分花在这。

## 4. 我们插件的现状

`lib/dsh-tools-bridge.js`：

- `ctx.inject(['tools'], scope => install(scope))` —— 注册在**根作用域**，所有 agent 共享一份。
- `mode === 'full'` 注册 28 个真工具；`mode === 'lazy'` 注册 3 个前门工具，
  `dsh_mcp_open` 再按 agent 往 `agent.ctx` 里**具名注册**（`openFor(agent)`，`:410-458`）。
- 已有一个 `visibleTo(agent, name)`（用 `service.get(name, agent)`）用于判断某 agent 是否已经看见某工具。

推论：**在 `lazy` 模式下，光靠 `when` 挡不住 `dsh_mcp_open` 打开的具名工具**——那些是 agent 作用域的
具名注册，不受根层 `when` 管。所以不管走哪条杠杆，`openFor` 都要另加一道判定。

## 5. 三个方案

| | A：配置 + `when` | B：配置 + 按 agent `restrict` | C：只做 MCP 侧过滤 |
|---|---|---|---|
| 机制 | 注册时挂 `when(agent)`，判定`本工作区是否可见` | 维护 agent 集合，逐个装 deny 层 | 在 `tools/list` 里按连接过滤 |
| 新增代码 | ~150–200 行（含配置解析、工作区解析缓存、`openFor` 闸门） | ~400–600 行（含生命周期、重装、复核） | ~60 行 |
| 覆盖 `lazy` 打开的具名工具 | 需在 `openFor` 加判定（已计划） | 天然覆盖（deny 层遮一切） | 不影响 DSH 侧 |
| 配置变更生效 | 插件重载即生效（chokidar 已支持） | 需重算并重装所有 agent 的层 | 重连生效 |
| 解决用户的问题 | **是** | 是 | **否**（MCP 客户端本来就没有工作区概念） |
| 风险 | 每步多 N 次判定（可缓存到 µs 级） | 生命周期漏挂/漏摘 ⇒ 该显示的没显示、该藏的没藏 | 无（但不解决问题） |

我推荐 **A**：

1. 我们的工具是「一整个面」而不是「按 agent 变化的能力」，`when` 的每步判定正合适；
2. 不引入 agent 生命周期管理——那正是 cherry 那 1,091 行里最容易出 bug 的部分
   （它自己就写了「late arrival after release」「exactly two timers, then silence」这类补丁）；
3. 出错的爆炸半径小：判据抛错被我们吞掉并**按不可见处理**（fail-closed），不会让工具消失到
   `ToolActivationError`。

## 6. 方案 A 的最小改动清单（预估）

| 文件 | 改动 | 行数量级 |
|---|---|---|
| `lib/tool-scope.js`（新） | 解析 `toolScope` 配置（`mode` + `workspaces`），fail-closed 到 `selected + []`；工作区匹配（见 §7 问题 2）；按 agent+cwd 缓存判定 | 120 |
| `lib/dsh-tools-bridge.js` | 给每个 definition 套 `when`（catch 内部错误 → false）；`openFor` 前先问 scope | 40 |
| `lib/capabilities/definitions.js` | `dsh_status` 增加 `scope` 段（mode、可见性、命中的工作区） | 20 |
| `config` / `cordis.patch.yml` 文档 + `docs/{zh,en}/*` | 配置说明与示例 | 40 |
| `test/tool-scope-test.mjs`（新） | 全局/选中/不可见/配置损坏/缓存失效/`openFor` 拒绝 | 150 |

## 7. 待定（需要你拍板）

1. **默认值**：没配 `toolScope` 时是 `global`（保持现状、向后兼容）还是 `selected + []`（更安全但会让升级后工具突然消失）？
   我倾向 `global`：升级不应该改变既有行为，要收紧是显式决定。
2. **工作区用什么键**：`workspaceIds`（不透明的 id，需要 UI 或 `dsh_status` 才能查）还是**路径**（`~/repo/xxx`，YAML 里能直接写）？
   我倾向**路径**——我们的配置是 YAML 手写的，没有设置页，写 id 等于写不出来。路径需要规范化（`realpath` + 去尾斜杠 + 大小写按平台）。
3. **匹配规则**：精确等于工作区根，还是**前缀包含**（`~/repo/hermes` 下的子目录也算）？
   我倾向前缀包含，但只在路径段边界上匹配（`/repo/hermes` 不匹配 `/repo/hermes-old`）。
4. **要不要设置页 UI**：只做配置（零 UI）还是加一个只读展示到现有 `/mcp-config` 页？
   我倾向先只做配置 + `dsh_status` 只读展示，等真有人嫌改 YAML 麻烦再加 UI。
5. **MCP 客户端侧要不要也开一个开关**：外部客户端（Hermes）没有工作区概念，但可以按「连接」过滤
   （例如 `mcpToolScope`）。我先不做，除非你觉得 Hermes 那边也需要省 token。
