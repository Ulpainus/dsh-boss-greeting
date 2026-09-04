# dsh-boss-greeting

[中文](README.zh.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin for semi-automated job application on Boss Zhipin (BOSS 直聘): search jobs, review them in a floating panel (or let the agent score them in chat), confirm the ones you want, and greet the recruiters one by one with human-like pacing.

## Features

- **5 agent tools**: `boss_login` (persistent browser + QR-code login), `boss_search` (intercepts the job-list API for plaintext salary; keyword/blacklist/salary-range filters), `boss_greet` (greets only the job IDs you confirmed, random 4–8 s intervals, skips already-greeted, stops on daily limit or slider captcha), `boss_records` (local records), `boss_stop` (abort the running loop).
- **Web floating panel** (bottom-right "Boss" button on the dsh page): status area (login state / task progress with live log), search form, result checklist with select-all, greeting editor, greeted-records view. Polls `/boss-greeting/api/status` (2 s while running, 10 s idle).
- **HTTP API** under `/boss-greeting/api/*` bridging the panel and the host, guarded by a loopback browser-trust fence (Host must be loopback, cross-site markers rejected, Origin must match Host).
- **Local JSON storage** (`data/jobs.json`, `data/greeted.json`) — dedup by `securityId`, daily greet counting; login state persists in `userdata/` (patchright persistent context).
- The AI matching/scoring is done by the dsh agent in conversation — the plugin only returns structured job data and never calls an LLM itself.

## Install

```sh
npm install
npm run build
# install from a local checkout (or straight from git: dsh plugin --profile web add github:<owner>/<repo>)
dsh plugin --profile web add link:/absolute/path/to/dsh-boss-greeting
```

Then start dsh normally — no `--patch` needed:

```sh
dsh web
```

Install the browser binary before first use: `npx patchright install chromium`. It lands in the standard location (`%LOCALAPPDATA%\ms-playwright` on Windows); if you keep it elsewhere, set `PLAYWRIGHT_BROWSERS_PATH` before starting dsh (see `src/host/env.ts`).

## Usage

1. In the dsh web UI, click the floating **Boss** button → "打开浏览器登录", scan the QR code in the opened window (login persists afterwards).
2. Either search from the panel, or ask the agent in chat: "搜一下北京的前端岗位，15K 以上" — the agent calls `boss_search`, shows a filtered list, and you confirm which ones to greet.
3. The agent calls `boss_greet` with only the confirmed job IDs; the panel shows live progress and can stop the loop at any time.

## Configuration

Set via `config:` on the plugin row (see `cordis.patch.yml`):

| Field | Default | Description |
| --- | --- | --- |
| `greetingTemplate` | 您好，我对贵司这个岗位很感兴趣…… | Default greeting when `boss_greet` gets no `greeting` |
| `delayMinSec` / `delayMaxSec` | 4 / 8 | Random interval between two greetings |
| `maxGreetPerDay` | 100 | Daily greet cap (local, anti risk-control) |
| `headless` | false | Must stay false — Boss Zhipin blocks headless browsers |
| `userDataDir` | `<plugin>/userdata` | Persistent browser profile directory |

## Development

```sh
npm run build       # lib/index.js + lib/client.js
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
```

Layout: `src/index.ts` (host entry, wiring only), `src/host/` (browser / search / greet / store / actions / http / tools / env), `src/client/` (React panel), `src/shared/` (API paths & payload types shared by both sides), `lib/` (build output, git-ignored).

## Disclaimer

This project is for learning and communication only. It does not bypass any platform security mechanism — login is done by yourself via QR code, and all operations go through your own logged-in session. Please comply with Boss Zhipin's terms of service, control your greeting frequency (`maxGreetPerDay`, delays), and take responsibility for how you use it. The authors assume no liability for account restrictions or other consequences caused by misuse.
