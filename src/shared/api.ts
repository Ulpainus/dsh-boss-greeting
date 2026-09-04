/**
 * host 与 client 共享的 API 路径与 payload 类型。
 * 只放纯类型与常量——client bundle 会 inline 常量、擦除类型，不能依赖任何 host 运行时。
 */

export const API_BASE = '/boss-greeting/api'

export const API_PATHS = {
  status: `${API_BASE}/status`,
  login: `${API_BASE}/login`,
  search: `${API_BASE}/search`,
  greet: `${API_BASE}/greet`,
  stop: `${API_BASE}/stop`,
  records: `${API_BASE}/records`,
} as const

/** 岗位条目（搜索/记录接口返回的单条）。 */
export interface JobItem {
  id: string
  jobName: string
  company: string
  salary: string
  city: string
  tags: string[]
  bossActive: string
  greeted: boolean
  greetedAt?: string
}

/** 打招呼任务进度。 */
export interface GreetProgressPayload {
  running: boolean
  processed: number
  total: number
  log: string[]
  lastError?: string
}

/** GET /status 的响应。 */
export interface StatusPayload {
  loggedIn: boolean
  browserLaunched: boolean
  greet: GreetProgressPayload
  counts: { total: number; ungreeted: number; greetedToday: number }
  defaults: { greetingTemplate: string; delayMinSec: number; delayMaxSec: number; maxGreetPerDay: number }
}
