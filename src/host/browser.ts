import type { BrowserContext, Page } from 'patchright'

// patchright 必须动态导入：esbuild 打包成单个 ESM 文件后，顶层 import 会在模块体
// （含 env.ts 里设置 PLAYWRIGHT_BROWSERS_PATH 的代码）之前求值，导致浏览器路径
// 环境变量来不及生效。懒加载保证 env.ts 先执行。
async function loadChromium() {
  const { chromium } = await import('patchright')
  return chromium
}

export const JOBS_URL = 'https://www.zhipin.com/web/geek/jobs'

export interface BrowserOptions {
  headless: boolean
  userDataDir: string
}

/** 可被中止的 sleep：signal 触发时立即 reject。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** [min, max] 毫秒区间内的随机延迟，模拟真人操作节奏。 */
export function randomDelay(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const ms = minMs + Math.random() * Math.max(0, maxMs - minMs)
  return sleep(ms, signal)
}

/**
 * 浏览器会话管理：单例懒加载的持久化上下文。
 * 登录态保存在 userDataDir 中，重启 dsh 后无需重新扫码。
 */
export class BrowserManager {
  private context: BrowserContext | undefined
  private page: Page | undefined
  private launching: Promise<BrowserContext> | undefined

  constructor(private options: BrowserOptions) {}

  /** 浏览器是否已启动（持久化上下文存在且连接正常）。 */
  get launched(): boolean {
    return this.context !== undefined && (this.context.browser()?.isConnected() ?? false)
  }

  async getContext(): Promise<BrowserContext> {
    if (this.context && this.context.browser()?.isConnected()) return this.context
    // 并发调用共享同一次启动
    // 注意：不要加 ignoreDefaultArgs / AutomationControlled 之类的反检测补丁——
    // patchright 自身已处理 CDP 检测，手动补丁反而会制造不一致特征（实测会触发 Boss 反爬导致 about:blank）
    this.launching ??= loadChromium().then((chromium) => chromium.launchPersistentContext(this.options.userDataDir, {
      headless: this.options.headless,
      viewport: null,
      args: ['--start-maximized'],
    })).then((context) => {
      this.context = context
      context.on('close', () => {
        this.context = undefined
        this.page = undefined
      })
      return context
    }).finally(() => {
      this.launching = undefined
    })
    return this.launching
  }

  /** 复用已有标签页（Boss 是 SPA，单页操作即可），没有则新开一个。 */
  async getPage(): Promise<Page> {
    const context = await this.getContext()
    if (this.page && !this.page.isClosed()) return this.page
    this.page = context.pages()[0] ?? await context.newPage()
    return this.page
  }

  /** 通过 cookie 判断是否已登录（zp_token/geek_zp_token 任一存在即视为已登录）。 */
  async isLoggedIn(): Promise<boolean> {
    if (!this.context) return false
    try {
      const cookies = await this.context.cookies('https://www.zhipin.com')
      return cookies.some(c => ['zp_token', 'geek_zp_token', 'bst'].includes(c.name) && c.value !== '')
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    const context = this.context
    this.context = undefined
    this.page = undefined
    await context?.close().catch(() => {})
  }
}
