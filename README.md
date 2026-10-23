# dsh-agents-init

把「写 AGENTS.md」这件事整个放进子代理里跑。主对话只发出命令、只收到结果，**指令正文一次都不进入主窗口**。

[English](README.en.md) | 中文

## 它是怎么做到零上下文的

通常的技能（skill）必须先加载进模型上下文，模型才能照着做——这本身就是开销。这个插件绕开了这一步：

```
用户输入 /agentinit
      ↓
命令处理器直接调用 ctx.subagents.startActivation()
      ↓
子代理在自己的上下文里读 references/methodology.md，干活
      ↓
子代理结束，报告作为 subagent-settled 通知回传并唤醒主代理
```

关键在于**命令处理器是宿主代码，不是模型**。它直接派生出一个子代理，方法文档由子代理自己读取。主窗口全程没有见过任何一条指令。

| | 传统技能 | 本插件 |
|---|---|---|
| 激活时进入主窗口 | 全部指令（数千 tokens） | **0** |
| 方法文档的读者 | 主模型 | 子代理 |
| 主窗口最终付出 | 指令 + 工具轨迹 + 报告 | **命令回执 + 报告** |

这不是「把技能写短一点」，而是根本不让它进入上下文。

## 用法

```
/agentinit                          # 直接开始
/agentinit audit this repo          # 带上你的要求，原样转给子代理
```

命令会立即返回一行回执，例如：

> Started an AGENTS.md subagent (child-0123456). Its report will arrive when it finishes; this conversation stays out of the work until then.

子代理完成后，报告自动回传。**期间主对话可以继续做别的事**——它没有被阻塞。

## 安装

```bash
plugin_manager  action=install_bundle  target=<本目录的绝对路径>
```

本组合包插入一行宿主条目（`skill-agents-init`）。`index.js` **只导入 Node 内置模块**，因此能在任何 profile 中激活，不依赖对 `@deepseek-ai/*` 包的 peer 解析。

## 配置

全部可选。未知字段和类型错误会让激活直接失败，而不是静默忽略。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `spawn` | 子代理后端名。`spawn` 是 `dsh-base` 挂载的进程内实现。 |
| `agentPreset` | `""` | 给子代理指定一个 agent preset；留空则继承父级。 |
| `allowMethodEdit` | `true` | 是否允许子代理修正方法文档（当某次运行证明某条规则是错的）。 |
| `activationNote` | `""` | 追加到每次运行的额外指引。 |

```yaml
- id: skill-agents-init
  name: dsh-agents-init
  config:
    provider: spawn
```

如果配置了不存在的 `provider`，命令会立刻报错并列出当前可用的后端名，不会静默失败。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主插件：`/agentinit` 命令 + 直接派生子代理。 |
| `references/methodology.md` | 方法。**只被子代理读取**，从不进入主窗口。 |
| `cordis.patch.yml` | 插入宿主条目的组合包补丁。 |
| `scripts/agents_md.py` | 只读检查器，核验命令与路径（`sections`、`check`、`stats`）。 |
| `locale/en.json`、`locale/zh.json` | 插件管理页的展示元数据。 |
| `test/smoke.mjs` | 离线契约检查，使用假的 context。 |
| `test/runtime.mjs` | 挂载到真实 Cordis 运行时，驱动真实的 commands 服务。 |

测试用纯 Node 运行，无任何依赖：

```bash
node test/smoke.mjs
node test/runtime.mjs
```

`test/runtime.mjs` 需要一份 DSH 安装。它会自动搜索常见位置，也接受 `DSH_INSTALL_ROOT`；找不到时打印 SKIPPED 并以 0 退出。

## 为什么没有 SKILL.md

早期版本把它做成了技能 + `/agentinit` 命令。技能路径的问题是：`SKILL.md` 必须注入主窗口才能生效，那 686 tokens 是每次运行都要付的。

现在插件不再注册技能提供方，`SKILL.md` 已删除。方法只有一个副本（`references/methodology.md`），且只有一个读者（子代理）。代价是：模型不能主动「发现」这个能力，只能由你输入 `/agentinit` 触发——这正是你要的取舍。

## 已知边界

**隔离的是生产过程，不是产物。** `AGENTS.md` 一旦写入仓库，就会被 `dsh-agent-instructions` 自动注入——它把 `AGENTS.md` / `CLAUDE.md` 作为候选，从项目根到会话工作目录全链路加载。子代理能让你不为一整个仓库的阅读付上下文，但产出的那份文件本身仍要按设计进入每次请求。这正是 AGENTS.md 的取舍：一份小文件，换取每次请求的正确性。

**修改本插件后需要重启宿主。** Node 的 ESM 没有模块缓存失效机制，插件重新启用时会复用进程内已加载的模块。改动 `index.js` 后请重启 DSH，而不是只切换插件的启用状态。`references/methodology.md` 不受影响——它每次运行都重新读取。
