# dsh-boss-greeting

中文 | [English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：Boss 直聘半自动投简历。搜索岗位 → 在悬浮面板（或对话里让 agent 打分筛选）确认清单 → 以拟人节奏逐个向 BOSS 打招呼。

## 功能

- **5 个 agent 工具**：`boss_login`（持久化浏览器 + 扫码登录）、`boss_search`（拦截岗位列表接口拿明文薪资，支持关键词/公司黑名单/薪资区间过滤）、`boss_greet`（只投你确认过的 jobIds，岗位间随机 4–8 秒间隔，自动跳过已沟通，遇到每日上限或滑块验证会停止并说明）、`boss_records`（本地记录查询）、`boss_stop`（中止投递循环）。
- **Web 悬浮面板**（dsh 页面右下角 "Boss" 按钮）：状态区（登录态/任务实时进度日志）、搜索区、结果复选清单（全选/清空）、招呼语编辑、已沟通记录区。运行中每 2 秒、空闲每 10 秒轮询 `/boss-greeting/api/status`。
- **HTTP API**：`/boss-greeting/api/*` 桥接面板与 host，带 loopback 浏览器信任检查（Host 必须 loopback、拒绝 cross-site 标记、Origin 必须与 Host 同源）。
- **本地 JSON 存储**（`data/jobs.json`、`data/greeted.json`）：按 `securityId` 去重、按日统计沟通数；登录态保存在 `userdata/`（patchright 持久化上下文）。
- AI 匹配打分由 dsh agent 在对话中完成，插件只返回结构化岗位数据，自身不调用任何 LLM。

## 安装

```sh
npm install
npm run build
# 本地目录安装（也可以直接从 git 安装：dsh plugin --profile web add github:<owner>/<repo>）
dsh plugin --profile web add link:/path/to/dsh-boss-greeting
```

之后正常启动即可，无需再传 `--patch`：

```sh
dsh web
```

首次使用前安装浏览器二进制：`npx patchright install chromium`。默认装到系统标准位置（Windows 为 `%LOCALAPPDATA%\ms-playwright`）；如装在自定义位置，启动 dsh 前设置 `PLAYWRIGHT_BROWSERS_PATH`（见 `src/host/env.ts`）。

## 使用

1. 在 dsh 网页点右下角 **Boss** 悬浮按钮 →"打开浏览器登录"，在弹出的窗口里扫码（之后登录态持久化，无需再扫）。
2. 可以直接在面板里搜索；也可以在对话里让 agent 搜："搜一下北京的前端岗位，15K 以上"——agent 调 `boss_search` 返回清单，你确认要投哪些。
3. agent 只对确认过的 jobIds 调 `boss_greet`；面板实时显示进度，可随时"停止"。

## 配置项

在插件行上加 `config:`（见 `cordis.patch.yml`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `greetingTemplate` | 您好，我对贵司这个岗位很感兴趣…… | `boss_greet` 未传 `greeting` 时的默认招呼语 |
| `delayMinSec` / `delayMaxSec` | 4 / 8 | 两次打招呼之间的随机间隔（秒） |
| `maxGreetPerDay` | 100 | 每日沟通上限（本地计数，防风控） |
| `headless` | false | 必须保持 false——Boss 直聘会封无头浏览器 |
| `userDataDir` | `<插件目录>/userdata` | 浏览器持久化用户数据目录 |

## 开发

```sh
npm run build       # 产出 lib/index.js + lib/client.js
npm run watch       # 监听 src/ 自动重构建
npm run typecheck   # tsc --noEmit
```

目录结构：`src/index.ts`（host 入口，只做组装）、`src/host/`（browser / search / greet / store / actions / http / tools / env）、`src/client/`（React 面板）、`src/shared/`（host 与 client 共享的 API 路径与类型）、`lib/`（构建产物，不提交）。

## 免责声明

本项目仅供学习交流使用。插件不绕过任何平台安全机制——登录由你本人扫码完成，所有操作都在你自己的已登录会话内进行。请遵守 BOSS 直聘的平台协议与用户规则，自行控制打招呼频率（`maxGreetPerDay` 与间隔参数），并为使用后果自行负责。因滥用导致的账号限制或其他后果，作者概不负责。
