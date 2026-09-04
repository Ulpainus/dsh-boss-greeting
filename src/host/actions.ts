import { JOBS_URL, sleep, type BrowserManager } from './browser.ts'
import type { GreetProgress, GreetRunner } from './greet.ts'
import { searchJobs } from './search.ts'
import type { JobRecord, JobStore, RecordStatus } from './store.ts'

/** 插件配置中 actions 实际用到的子集（Config 结构满足即可，避免循环 import）。 */
export interface ActionConfig {
  greetingTemplate: string
  delayMinSec: number
  delayMaxSec: number
  maxGreetPerDay: number
}

/** 共享依赖：host 工具与 HTTP 端点都基于它操作。 */
export interface Deps {
  store: JobStore
  browser: BrowserManager
  runner: GreetRunner
  config: ActionConfig
}

export interface StatusPayload {
  loggedIn: boolean
  browserLaunched: boolean
  greet: GreetProgress
  counts: { total: number; ungreeted: number; greetedToday: number }
  defaults: { greetingTemplate: string; delayMinSec: number; delayMaxSec: number; maxGreetPerDay: number }
}

/** 面板/工具共用的状态快照。 */
export async function getStatus(deps: Deps): Promise<StatusPayload> {
  const records = deps.store.list('all')
  return {
    loggedIn: await deps.browser.isLoggedIn(),
    browserLaunched: deps.browser.launched,
    greet: deps.runner.getProgress(),
    counts: {
      total: records.length,
      ungreeted: records.filter(j => !j.greeted).length,
      greetedToday: deps.store.greetedTodayCount(),
    },
    defaults: {
      greetingTemplate: deps.config.greetingTemplate,
      delayMinSec: deps.config.delayMinSec,
      delayMaxSec: deps.config.delayMaxSec,
      maxGreetPerDay: deps.config.maxGreetPerDay,
    },
  }
}

/**
 * 启动浏览器并打开岗位页。已登录则直接返回；未登录返回提示，
 * 扫码后的登录态变化通过 getStatus 轮询可见（HTTP 场景不应长占请求）。
 */
export async function openLoginPage(deps: Deps): Promise<{ loggedIn: boolean; message: string }> {
  await deps.browser.getContext()
  const page = await deps.browser.getPage()
  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  if (await deps.browser.isLoggedIn()) {
    return { loggedIn: true, message: '已处于登录状态。' }
  }
  return { loggedIn: false, message: '浏览器已打开，请在窗口中扫码登录；登录成功后状态会自动更新。' }
}

/** 工具版登录：阻塞轮询扫码，最长 5 分钟。 */
export async function waitForLogin(deps: Deps, signal: AbortSignal): Promise<{ success: boolean; alreadyLoggedIn: boolean; message: string }> {
  const opened = await openLoginPage(deps)
  if (opened.loggedIn) {
    return { success: true, alreadyLoggedIn: true, message: '已处于登录状态，可以直接使用 boss_search 搜索岗位。' }
  }
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(2000, signal)
    if (await deps.browser.isLoggedIn()) {
      return { success: true, alreadyLoggedIn: false, message: '登录成功，登录态已持久化，后续无需再扫码。' }
    }
  }
  return { success: false, alreadyLoggedIn: false, message: '等待扫码超时（5 分钟）。请在浏览器窗口中完成扫码后重新登录。' }
}

export interface SearchParams {
  query: string
  city?: string
  salary?: string
  maxPages?: number
  excludeKeywords?: string[]
  companyBlacklist?: string[]
  minSalaryK?: number
  maxSalaryK?: number
}

export interface SearchPayload {
  count: number
  newCount: number
  pagesFetched: number
  note?: string
  jobs: Array<JobRecord & { greeted: boolean; greetedAt?: string }>
}

/** 搜索岗位并入库（未登录返回空结果 + note 说明，不抛异常）。 */
export async function searchAndStore(deps: Deps, params: SearchParams, signal: AbortSignal): Promise<SearchPayload> {
  if (!await deps.browser.isLoggedIn()) {
    return {
      count: 0, newCount: 0, pagesFetched: 0,
      note: '未登录 Boss 直聘，请先登录（工具 boss_login 或面板"打开浏览器登录"）。',
      jobs: [],
    }
  }
  const page = await deps.browser.getPage()
  const result = await searchJobs(page, {
    query: params.query,
    city: params.city ?? '100010000',
    ...(params.salary !== undefined ? { salary: params.salary } : {}),
    maxPages: params.maxPages ?? 3,
    excludeKeywords: params.excludeKeywords ?? [],
    companyBlacklist: params.companyBlacklist ?? [],
    ...(params.minSalaryK !== undefined ? { minSalaryK: params.minSalaryK } : {}),
    ...(params.maxSalaryK !== undefined ? { maxSalaryK: params.maxSalaryK } : {}),
  }, signal)
  const newCount = deps.store.upsertJobs(result.jobs)
  const jobs = result.jobs.map(job => ({
    ...job,
    greeted: deps.store.isGreeted(job.securityId),
    ...(deps.store.greetedAt(job.securityId) !== undefined ? { greetedAt: deps.store.greetedAt(job.securityId) } : {}),
  }))
  return {
    count: jobs.length,
    newCount,
    pagesFetched: result.pagesFetched,
    ...(result.note !== undefined ? { note: result.note } : {}),
    jobs,
  }
}

/** 解析 jobIds 为存储中的岗位记录，返回命中与缺失两组。 */
export function resolveGreetTargets(deps: Deps, jobIds: string[]): { jobs: JobRecord[]; missing: string[] } {
  const jobs: JobRecord[] = []
  const missing: string[] = []
  for (const id of jobIds) {
    const record = deps.store.getJob(id)
    if (record) jobs.push(record)
    else missing.push(id)
  }
  return { jobs, missing }
}

export interface StartGreetParams {
  jobIds: string[]
  greeting?: string
  maxCount?: number
  delayMinSec?: number
  delayMaxSec?: number
}

/**
 * 后台启动打招呼循环（HTTP 场景）：立即返回，进度经 getStatus 轮询。
 * 循环用独立的 AbortController，不随请求断开而中止；boss_stop 可中止。
 */
export function startGreetInBackground(deps: Deps, params: StartGreetParams): { started: boolean; message: string } {
  if (deps.runner.running) {
    return { started: false, message: '已有正在运行的打招呼任务，请先停止后再试。' }
  }
  const { jobs, missing } = resolveGreetTargets(deps, params.jobIds)
  if (jobs.length === 0) {
    return { started: false, message: `提供的 jobIds 在本地记录中都找不到（${missing.join(', ')}），请先搜索。` }
  }
  void (async () => {
    const page = await deps.browser.getPage()
    await deps.runner.run(page, deps.store, jobs, {
      greeting: params.greeting ?? deps.config.greetingTemplate,
      maxCount: params.maxCount ?? 10,
      delayMinSec: params.delayMinSec ?? deps.config.delayMinSec,
      delayMaxSec: params.delayMaxSec ?? deps.config.delayMaxSec,
      maxGreetPerDay: deps.config.maxGreetPerDay,
    }, new AbortController().signal)
  })().catch((error: unknown) => {
    deps.runner.noteError(error instanceof Error ? error.message : String(error))
  })
  return {
    started: true,
    message: `已开始对 ${Math.min(jobs.length, params.maxCount ?? 10)} 个岗位打招呼${missing.length > 0 ? `（${missing.length} 个 id 未找到，已忽略）` : ''}，进度请查看状态区。`,
  }
}

/** 中止当前打招呼循环。 */
export function stopGreet(deps: Deps): { stopped: boolean; message: string } {
  const stopped = deps.runner.stop()
  return {
    stopped,
    message: stopped ? '已发送中止信号，打招呼循环会在当前岗位处理完后停止。' : '当前没有正在运行的打招呼任务。',
  }
}

/** 查询本地岗位记录。 */
export function listRecords(deps: Deps, status: RecordStatus): { count: number; greetedToday: number; jobs: ReturnType<JobStore['list']> } {
  const jobs = deps.store.list(status)
  return { count: jobs.length, greetedToday: deps.store.greetedTodayCount(), jobs }
}
