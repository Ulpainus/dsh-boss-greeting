import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条岗位记录，id 与 securityId 相同（Boss 接口的稳定去重键）。 */
export interface JobRecord {
  id: string
  jobName: string
  company: string
  salary: string
  city: string
  tags: string[]
  bossActive: string
  securityId: string
  lid: string
  encryptJobId: string
  detailUrl: string
  foundAt: string
}

export type RecordStatus = 'all' | 'ungreeted' | 'greeted'

/** 纯 JSON 文件存储：jobs.json 放岗位记录，greeted.json 放已沟通索引。 */
export class JobStore {
  private jobs = new Map<string, JobRecord>()
  /** securityId -> ISO 时间戳 */
  private greeted = new Map<string, string>()
  private readonly jobsPath: string
  private readonly greetedPath: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.jobsPath = join(dataDir, 'jobs.json')
    this.greetedPath = join(dataDir, 'greeted.json')
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.jobsPath)) {
        const list = JSON.parse(readFileSync(this.jobsPath, 'utf8')) as JobRecord[]
        for (const job of list) this.jobs.set(job.securityId, job)
      }
    } catch {
      // 文件损坏时从空集合开始，不阻塞插件加载
    }
    try {
      if (existsSync(this.greetedPath)) {
        const map = JSON.parse(readFileSync(this.greetedPath, 'utf8')) as Record<string, string>
        for (const [id, at] of Object.entries(map)) this.greeted.set(id, at)
      }
    } catch {
      // 同上
    }
  }

  private saveJobs(): void {
    writeFileSync(this.jobsPath, JSON.stringify([...this.jobs.values()], null, 2))
  }

  private saveGreeted(): void {
    writeFileSync(this.greetedPath, JSON.stringify(Object.fromEntries(this.greeted), null, 2))
  }

  /** 按 securityId 去重 upsert，返回新增条数。 */
  upsertJobs(records: JobRecord[]): number {
    let added = 0
    for (const record of records) {
      if (!record.securityId) continue
      if (!this.jobs.has(record.securityId)) added += 1
      this.jobs.set(record.securityId, record)
    }
    this.saveJobs()
    return added
  }

  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  isGreeted(securityId: string): boolean {
    return this.greeted.has(securityId)
  }

  greetedAt(securityId: string): string | undefined {
    return this.greeted.get(securityId)
  }

  markGreeted(securityId: string, at: string = new Date().toISOString()): void {
    this.greeted.set(securityId, at)
    this.saveGreeted()
  }

  /** 今日已沟通数量（按本地日期统计），用于 maxGreetPerDay 上限。 */
  greetedTodayCount(): number {
    const today = new Date().toDateString()
    let count = 0
    for (const at of this.greeted.values()) {
      if (new Date(at).toDateString() === today) count += 1
    }
    return count
  }

  list(status: RecordStatus = 'all'): Array<JobRecord & { greeted: boolean; greetedAt?: string }> {
    const result = [...this.jobs.values()].map(job => ({
      ...job,
      greeted: this.greeted.has(job.securityId),
      ...(this.greeted.has(job.securityId) ? { greetedAt: this.greeted.get(job.securityId) } : {}),
    }))
    if (status === 'greeted') return result.filter(j => j.greeted)
    if (status === 'ungreeted') return result.filter(j => !j.greeted)
    return result
  }
}
