import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  listRecords, resolveGreetTargets, searchAndStore, stopGreet, waitForLogin,
  type Deps,
} from './actions.ts'
import { isAbortError } from './browser.ts'
import type { RecordStatus } from './store.ts'

/** 岗位记录的规范输出 schema（boss_search / boss_records 共用）。 */
const jobSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: '岗位 id（即 securityId），boss_greet 的 jobIds 使用此值' },
    jobName: { type: 'string', required: true },
    company: { type: 'string', required: true },
    salary: { type: 'string', required: true, description: '明文薪资，如 15-30K·13薪' },
    city: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    bossActive: { type: 'string', required: true, description: 'BOSS 活跃状态，如 "在线"、"3 分钟前活跃"' },
    securityId: { type: 'string', required: true },
    lid: { type: 'string', required: true },
    encryptJobId: { type: 'string', required: true },
    detailUrl: { type: 'string', required: true },
    foundAt: { type: 'string', required: true },
    greeted: { type: 'boolean', required: true, description: '是否已沟通过' },
    greetedAt: { type: 'string', description: '已沟通时间（ISO），仅 greeted 为 true 时存在' },
  },
} as const

const greetOutcomeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    jobName: { type: 'string', required: true },
    company: { type: 'string', required: true },
    status: { type: 'string', enum: ['greeted', 'already', 'failed', 'limit', 'captcha', 'stopped'], required: true },
    message: { type: 'string', required: true },
  },
} as const

export function registerTools(ctx: Context, deps: Deps): void {
  const { store, browser, runner, config } = deps

  ctx.tools.register(defineTool({
    name: 'boss_login',
    description: '启动 Boss 直聘浏览器并等待扫码登录。会打开一个带持久化登录态的浏览器窗口；未登录时请用户在窗口中扫码，已登录则直接返回成功。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          alreadyLoggedIn: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(_args, exec) {
      return waitForLogin(deps, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_search',
    description: '搜索 Boss 直聘岗位列表。通过拦截岗位列表接口拿到结构化数据（含明文薪资），应用关键词/黑名单/薪资区间过滤后存入本地记录，并返回岗位数组供你筛选打分。需要先 boss_login。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词，如 "前端工程师"' },
      city: { type: 'string', description: '城市代码，默认 100010000（全国）。如北京 101010100、上海 101020100、深圳 101280600' },
      salary: { type: 'string', description: 'Boss 薪资代码，如 405 表示 20-50K，不传表示不限' },
      maxPages: { type: 'number', description: '最多翻页数，默认 3' },
      excludeKeywords: { type: 'array', items: { type: 'string' }, description: '岗位名/公司/标签中包含这些关键词则排除' },
      companyBlacklist: { type: 'array', items: { type: 'string' }, description: '公司黑名单，公司名包含即排除' },
      minSalaryK: { type: 'number', description: '最低薪资（K），按明文薪资区间过滤，如 15' },
      maxSalaryK: { type: 'number', description: '最高薪资（K），按明文薪资区间过滤，如 30' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          newCount: { type: 'number', required: true, description: '本次新入库的岗位数' },
          pagesFetched: { type: 'number', required: true },
          note: { type: 'string' },
          jobs: { type: 'array', items: jobSchema, required: true },
        },
      },
      render: (_args, value) => {
        const lines = value.jobs.map((j, i) =>
          `${i + 1}. [${j.id.slice(0, 8)}…] ${j.jobName} | ${j.company} | ${j.salary} | ${j.city} | ${j.bossActive || '活跃未知'}${j.greeted ? ' | 已沟通' : ''}`)
        const header = `共找到 ${value.count} 个岗位（新入库 ${value.newCount}，抓取 ${value.pagesFetched} 页）${value.note ? `\n注意：${value.note}` : ''}`
        return [{ type: 'text', text: [header, ...lines].join('\n') }]
      },
    },
    async execute(args, exec) {
      return searchAndStore(deps, args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_greet',
    description: '向用户确认过的岗位逐个发送打招呼语（半自动投递）。只处理 jobIds 指定的岗位，自动跳过已沟通的，岗位间有随机间隔。遇到每日上限或滑块验证会停止并说明。需要先 boss_login。',
    parameters: {
      jobIds: { type: 'array', items: { type: 'string' }, required: true, description: '要沟通的岗位 id 数组（boss_search/boss_records 返回的 id 字段）' },
      greeting: { type: 'string', description: '自定义招呼语，不传则使用插件配置的默认模板' },
      maxCount: { type: 'number', description: '本次最多沟通多少个岗位，默认 10' },
      delayMinSec: { type: 'number', description: '岗位间最小间隔秒数，默认取插件配置' },
      delayMaxSec: { type: 'number', description: '岗位间最大间隔秒数，默认取插件配置' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          greeted: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          stopped: { type: 'boolean', required: true, description: '是否被 boss_stop 或取消信号中止' },
          note: { type: 'string' },
          results: { type: 'array', items: greetOutcomeSchema, required: true },
        },
      },
      render: (_args, value) => {
        const statusText: Record<string, string> = {
          greeted: '已沟通', already: '跳过(已沟通)', failed: '失败', limit: '已达上限', captcha: '需验证', stopped: '已中止',
        }
        const lines = value.results.map(r => `- [${statusText[r.status] ?? r.status}] ${r.jobName} | ${r.company}：${r.message}`)
        const header = `打招呼完成：成功 ${value.greeted}，跳过 ${value.skipped}，失败 ${value.failed}${value.stopped ? '（被中止）' : ''}${value.note ? `\n注意：${value.note}` : ''}`
        return [{ type: 'text', text: [header, ...lines].join('\n') }]
      },
    },
    async execute(args, exec) {
      if (!await browser.isLoggedIn()) {
        return {
          total: 0, greeted: 0, skipped: 0, failed: 0, stopped: false,
          note: '未登录 Boss 直聘，请先调用 boss_login 完成扫码登录。',
          results: [],
        }
      }
      if (runner.running) {
        return {
          total: 0, greeted: 0, skipped: 0, failed: 0, stopped: false,
          note: '已有正在运行的打招呼任务，请先调用 boss_stop 中止后再试。',
          results: [],
        }
      }

      const { jobs, missing } = resolveGreetTargets(deps, args.jobIds)
      if (jobs.length === 0) {
        return {
          total: 0, greeted: 0, skipped: 0, failed: 0, stopped: false,
          note: `提供的 jobIds 在本地记录中都找不到（${missing.join(', ')}），请先用 boss_search 搜索或 boss_records 查看可用 id。`,
          results: [],
        }
      }

      const page = await browser.getPage()
      try {
        const summary = await runner.run(page, store, jobs, {
          greeting: args.greeting ?? config.greetingTemplate,
          maxCount: args.maxCount ?? 10,
          delayMinSec: args.delayMinSec ?? config.delayMinSec,
          delayMaxSec: args.delayMaxSec ?? config.delayMaxSec,
          maxGreetPerDay: config.maxGreetPerDay,
        }, exec.signal)
        if (missing.length > 0) {
          const prefix = `以下 id 未在本地记录中找到，已忽略：${missing.join(', ')}`
          return { ...summary, note: summary.note ? `${prefix}；${summary.note}` : prefix }
        }
        return summary
      } catch (error) {
        if (isAbortError(error)) {
          return {
            total: 0, greeted: 0, skipped: 0, failed: 0, stopped: true,
            note: '任务被中止。',
            results: [],
          }
        }
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_records',
    description: '查看本地存储的 Boss 直聘岗位记录，可按是否已沟通过滤。',
    parameters: {
      status: { type: 'string', enum: ['all', 'ungreeted', 'greeted'], description: 'all=全部（默认），ungreeted=未沟通，greeted=已沟通' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          greetedToday: { type: 'number', required: true, description: '今日已沟通数量' },
          jobs: { type: 'array', items: jobSchema, required: true },
        },
      },
      render: (_args, value) => {
        const lines = value.jobs.map((j, i) =>
          `${i + 1}. [${j.id.slice(0, 8)}…] ${j.jobName} | ${j.company} | ${j.salary} | ${j.city}${j.greeted ? ` | 已沟通(${j.greetedAt ?? ''})` : ''}`)
        return [{ type: 'text', text: [`共 ${value.count} 条记录，今日已沟通 ${value.greetedToday} 个`, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      return listRecords(deps, (args.status ?? 'all') as RecordStatus)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_stop',
    description: '中止正在运行的 boss_greet 打招呼循环。当前岗位处理完后停止，已沟通的记录不会丢失。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'boolean', required: true, description: '是否成功发出了中止信号' },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      return stopGreet(deps)
    },
  }))
}
