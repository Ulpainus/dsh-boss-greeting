import type { Page } from 'patchright'
import type { JobRecord } from './store.ts'

/** 岗位列表接口（DOM 里薪资是加密字体，必须拦截接口拿明文）。 */
const JOBLIST_RE = /\/wapi\/zpgeek\/(?:search\/joblist|pc\/(?:recommend|search)\/job\/list)\.json/i

export interface SearchOptions {
  query: string
  city: string
  salary?: string
  maxPages: number
  excludeKeywords: string[]
  companyBlacklist: string[]
  minSalaryK?: number
  maxSalaryK?: number
}

export interface SearchResult {
  jobs: JobRecord[]
  pagesFetched: number
  /** 需要人工介入时的说明（滑块验证 / 接口为空等）。 */
  note?: string
}

/** 从 "15-30K·13薪" 这类明文薪资解析出 [min, max]（单位 K）。 */
export function parseSalaryK(salary: string): [number, number] | undefined {
  const match = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Kk]/.exec(salary)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2])]
}

/** 单页抓取：等 joblist 接口响应命中后再读 JSON。 */
async function fetchJobListPage(page: Page, url: string, signal: AbortSignal): Promise<unknown> {
  const responsePromise = page.waitForResponse(
    response => JOBLIST_RE.test(response.url()),
    { timeout: 30000 },
  )
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const response = await Promise.race([responsePromise, abortPromise])
  return response.json()
}

interface RawJobItem {
  jobName?: string
  brandName?: string
  salaryDesc?: string
  cityName?: string
  jobLabels?: string[]
  skills?: string[]
  welfareList?: string[]
  bossName?: string
  bossTitle?: string
  bossOnline?: boolean
  activeTimeDesc?: string
  bossActiveTimeDesc?: string
  bossActiveDesc?: string
  lastActiveTimeDesc?: string
  securityId?: string
  lid?: string
  encryptJobId?: string
}

function normalizeItem(item: RawJobItem): JobRecord | undefined {
  if (!item.securityId || !item.encryptJobId) return undefined
  const tags = [...(item.jobLabels ?? []), ...(item.skills ?? []), ...(item.welfareList ?? [])]
  // Boss 活跃度：bossOnline 为 true 即"在线"；否则按优先级取几个可能的活跃时间字段
  const rawDesc = item.activeTimeDesc ?? item.bossActiveTimeDesc ?? item.bossActiveDesc ?? item.lastActiveTimeDesc ?? ''
  const bossActive = (item.bossOnline === true || rawDesc === '在线') ? '在线' : rawDesc
  return {
    id: item.securityId,
    jobName: item.jobName ?? '',
    company: item.brandName ?? '',
    salary: item.salaryDesc ?? '',
    city: item.cityName ?? '',
    tags,
    bossActive,
    securityId: item.securityId,
    lid: item.lid ?? '',
    encryptJobId: item.encryptJobId,
    detailUrl: `https://www.zhipin.com/job_detail/${item.encryptJobId}.html?lid=${item.lid ?? ''}&securityId=${item.securityId}`,
    foundAt: new Date().toISOString(),
  }
}

function applyFilters(job: JobRecord, options: SearchOptions): boolean {
  const haystack = `${job.jobName} ${job.company} ${job.tags.join(' ')}`.toLowerCase()
  for (const keyword of options.excludeKeywords) {
    if (keyword && haystack.includes(keyword.toLowerCase())) return false
  }
  for (const blocked of options.companyBlacklist) {
    if (blocked && job.company.toLowerCase().includes(blocked.toLowerCase())) return false
  }
  // 薪资区间过滤：可解析时按区间相交判断；"面议" 等无法解析的保留
  const range = parseSalaryK(job.salary)
  if (range) {
    if (options.minSalaryK !== undefined && range[1] < options.minSalaryK) return false
    if (options.maxSalaryK !== undefined && range[0] > options.maxSalaryK) return false
  }
  return true
}

/** 检测是否触发了滑块/安全验证。 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  if (/captcha|security-verify|verify/i.test(page.url())) return true
  return page.locator('.geetest_panel, .nc-container, .slider-verify, #captcha').first()
    .isVisible({ timeout: 500 }).catch(() => false)
}

export async function searchJobs(page: Page, options: SearchOptions, signal: AbortSignal): Promise<SearchResult> {
  const jobs: JobRecord[] = []
  const seen = new Set<string>()
  let pagesFetched = 0
  let note: string | undefined

  for (let pageNo = 1; pageNo <= options.maxPages; pageNo += 1) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')

    const params = new URLSearchParams({ query: options.query, city: options.city })
    if (options.salary) params.set('salary', options.salary)
    if (pageNo > 1) params.set('page', String(pageNo))
    const url = `https://www.zhipin.com/web/geek/jobs?${params.toString()}`

    let data: unknown
    try {
      data = await fetchJobListPage(page, url, signal)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      if (await detectCaptcha(page)) {
        note = '检测到滑块/安全验证，请在浏览器窗口中手动完成验证后重试'
        break
      }
      note = `第 ${pageNo} 页抓取失败：${error instanceof Error ? error.message : String(error)}`
      break
    }

    if (await detectCaptcha(page)) {
      note = '检测到滑块/安全验证，请在浏览器窗口中手动完成验证后重试'
      break
    }

    const jobList = (data as { zpData?: { jobList?: RawJobItem[] } })?.zpData?.jobList
    if (!Array.isArray(jobList) || jobList.length === 0) {
      if (pageNo === 1) note = '接口未返回岗位列表，可能未登录或查询无结果'
      break
    }
    pagesFetched = pageNo

    for (const item of jobList) {
      const job = normalizeItem(item)
      if (!job || seen.has(job.securityId)) continue
      seen.add(job.securityId)
      if (!applyFilters(job, options)) continue
      jobs.push(job)
    }

    // 不足一页说明没有更多结果
    if (jobList.length < 10) break
  }

  return { jobs, pagesFetched, ...(note !== undefined ? { note } : {}) }
}
