import type { Page } from 'patchright'
import { isAbortError, randomDelay, sleep } from './browser.ts'
import { detectCaptcha } from './search.ts'
import type { JobRecord, JobStore } from './store.ts'

export type GreetStatus = 'greeted' | 'already' | 'failed' | 'limit' | 'captcha' | 'stopped'

export interface GreetOutcome {
  id: string
  jobName: string
  company: string
  status: GreetStatus
  message: string
}

export interface GreetSummary {
  total: number
  greeted: number
  skipped: number
  failed: number
  stopped: boolean
  /** 需要人工介入时的说明。 */
  note?: string
  results: GreetOutcome[]
}

export interface GreetOptions {
  greeting: string
  maxCount: number
  delayMinSec: number
  delayMaxSec: number
  maxGreetPerDay: number
}

/** 沟通上限弹窗的特征文案。 */
const LIMIT_RE = /今日.*(沟通|打招呼).*(上限|已达)|已达.*上限|沟通次数已达/

async function detectLimit(page: Page): Promise<boolean> {
  return page.getByText(LIMIT_RE).first().isVisible({ timeout: 500 }).catch(() => false)
}

interface GreetBase {
  id: string
  jobName: string
  company: string
}

/**
 * 首次沟通的弹窗路径（实测 Boss 行为：点"立即沟通"不跳聊天页，而是在详情页弹
 * .dialog-wrap.startchat-dialog）。输入框是 textarea.input-area（真 textarea，
 * fill 可用，但仍补 beforeinput/input 事件保证框架状态同步）；发送按钮是
 * div.send-message，写入文本后其 disable 类消失才可点。
 */
async function greetViaDialog(page: Page, base: GreetBase, greeting: string, signal: AbortSignal): Promise<GreetOutcome> {
  const textarea = page.locator('.dialog-wrap.startchat-dialog textarea.input-area')
  try {
    await textarea.waitFor({ state: 'visible', timeout: 8000 })
  } catch {
    return { ...base, status: 'failed', message: '沟通弹窗已打开但未找到输入框' }
  }
  await textarea.click()
  await textarea.fill(greeting)
  await page.evaluate((text) => {
    const el = document.querySelector('.dialog-wrap.startchat-dialog textarea.input-area') as HTMLTextAreaElement | null
    if (!el) return
    el.focus()
    el.value = text
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }, greeting)
  await randomDelay(400, 900, signal)

  // 等发送按钮激活（disable 类消失）
  const enabled = await page.waitForFunction(() => {
    const el = document.querySelector('.dialog-wrap.startchat-dialog .send-message')
    return el !== null && !el.classList.contains('disable')
  }, undefined, { timeout: 3000 }).then(() => true).catch(() => false)
  if (!enabled) {
    return { ...base, status: 'failed', message: '弹窗发送按钮未激活，文本可能未写入' }
  }
  await page.locator('.dialog-wrap.startchat-dialog .send-message').click()
  await sleep(800, signal)

  // 校验：弹窗消息列表出现该文本，或弹窗已关闭
  const sent = await page.evaluate((text) => {
    const list = document.querySelector('.dialog-wrap.startchat-dialog ul.message-list')
    if (list && (list.textContent ?? '').includes(text.slice(0, 12))) return true
    const dialog = document.querySelector('.dialog-wrap.startchat-dialog') as HTMLElement | null
    return dialog === null || !(dialog.offsetWidth || dialog.offsetHeight)
  }, greeting).catch(() => false)

  return sent
    ? { ...base, status: 'greeted', message: '已通过首次沟通弹窗发送招呼语' }
    : { ...base, status: 'failed', message: '点击发送后未能确认消息发出' }
}

/**
 * 单个岗位的打招呼流程：
 * 打开详情页 → 点"立即沟通" → 聊天页发送招呼语。
 * 点击后可能是 SPA 路由跳转到 /web/geek/chat，也可能弹出新标签页，两者都处理。
 */
async function greetOne(page: Page, job: JobRecord, greeting: string, signal: AbortSignal): Promise<GreetOutcome> {
  const base = { id: job.id, jobName: job.jobName, company: job.company }
  await page.goto(job.detailUrl, { waitUntil: 'domcontentloaded' })
  await randomDelay(1000, 2000, signal)

  if (await detectCaptcha(page)) {
    return { ...base, status: 'captcha', message: '触发滑块/安全验证，请在浏览器中手动完成' }
  }
  if (await detectLimit(page)) {
    return { ...base, status: 'limit', message: '今日沟通已达上限' }
  }

  // "继续沟通" 说明之前已经打过招呼
  const continueBtn = page.locator('a.btn-startchat:has-text("继续沟通"), .btn:has-text("继续沟通")').first()
  if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    return { ...base, status: 'already', message: '详情页显示"继续沟通"，此前已沟通过' }
  }

  const chatBtn = page.locator('a.btn-startchat:has-text("立即沟通"), .btn:has-text("立即沟通"), button:has-text("立即沟通")').first()
  try {
    await chatBtn.waitFor({ state: 'visible', timeout: 10000 })
  } catch {
    return { ...base, status: 'failed', message: '详情页未找到"立即沟通"按钮，岗位可能已关闭' }
  }

  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
  await chatBtn.click()
  const chatPage = (await popupPromise) ?? page
  await sleep(1500, signal)

  if (await detectLimit(chatPage)) {
    return { ...base, status: 'limit', message: '今日沟通已达上限' }
  }

  // 首次沟通：Boss 在当前详情页弹出 startchat 对话窗（不跳转聊天页），
  // 输入框是弹窗内的 textarea.input-area，发送按钮是 div.send-message（写入后失去 disable 类）
  const dialog = chatPage.locator('.dialog-wrap.startchat-dialog')
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    return greetViaDialog(chatPage, base, greeting, signal)
  }

  await chatPage.waitForURL(/\/web\/geek\/chat/, { timeout: 10000 }).catch(() => {})

  // 聊天输入框选择器梯队（参考油猴脚本实测）：优先 contenteditable 的 #chat-input
  const INPUT_SELECTOR = '#chat-input.chat-input[contenteditable="true"], #chat-input.chat-input, .chat-input[contenteditable="true"], .chat-input, [class*="chat-input"], .chat-conversation textarea, [contenteditable="true"]'
  try {
    await chatPage.waitForSelector(INPUT_SELECTOR, { state: 'visible', timeout: 10000 })
  } catch {
    return { ...base, status: 'failed', message: '已进入聊天页但未找到输入框，未发送' }
  }

  // 写入文本：聊天框是 contenteditable div，fill/keyboard.type 不一定触发框架状态，
  // 直接在页面上下文里 focus + 写 innerText + 派发 beforeinput/input 事件
  await chatPage.locator(INPUT_SELECTOR).first().click()
  await chatPage.evaluate((text) => {
    const input = document.querySelector('#chat-input.chat-input[contenteditable="true"], #chat-input.chat-input, .chat-input[contenteditable="true"], .chat-input, [class*="chat-input"], textarea, [contenteditable="true"]') as HTMLElement | null
    if (!input) return
    const target = (input.matches('textarea,input,[contenteditable="true"]')
      ? input
      : input.querySelector('textarea,input,[contenteditable="true"]') ?? input) as HTMLElement
    target.focus()
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      target.value = text
    } else {
      target.innerText = text
    }
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }, greeting)
  await randomDelay(500, 1200, signal)

  // Enter 发送；随后校验是否真正发出（输入框被清空，或聊天记录里出现该文本）
  await chatPage.keyboard.press('Enter')
  await sleep(800, signal)

  const verifySend = () => chatPage.evaluate((text) => {
    const input = document.querySelector('#chat-input.chat-input, .chat-input, [class*="chat-input"], textarea, [contenteditable="true"]') as HTMLElement | null
    const draft = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : (input?.innerText ?? '')
    if (!draft.includes(text.slice(0, 12))) return true // 输入框已清空 = 已发送
    const records = Array.from(document.querySelectorAll('.chat-record li, .message-item, .chat-message, [class*="message"]'))
    return records.some((el) => (el.textContent ?? '').includes(text.slice(0, 12)))
  }, greeting).catch(() => false)

  if (!(await verifySend())) {
    // Enter 没发出去，兜底点页面自己的发送按钮
    const sendBtn = chatPage.locator('button.btn-send:visible, .chat-op button:visible, button:has-text("发送"):visible').first()
    if (await sendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await sendBtn.click()
      await sleep(800, signal)
    }
    if (!(await verifySend())) {
      return { ...base, status: 'failed', message: '聊天页已打开但消息未能发出（Enter 和发送按钮都未生效）' }
    }
  }

  return { ...base, status: 'greeted', message: '已发送招呼语' }
}

/** 打招呼任务的实时进度（供 /status 轮询）。 */
export interface GreetProgress {
  running: boolean
  processed: number
  total: number
  /** 最近的操作日志（最多保留 30 条）。 */
  log: string[]
  lastError?: string
}

/** greet 循环的运行时管理：运行状态 + 可中止 + 进度上报。 */
export class GreetRunner {
  private controller: AbortController | undefined
  private progressProcessed = 0
  private progressTotal = 0
  private progressLog: string[] = []
  private lastError: string | undefined

  get running(): boolean {
    return this.controller !== undefined
  }

  getProgress(): GreetProgress {
    return {
      running: this.running,
      processed: this.progressProcessed,
      total: this.progressTotal,
      log: [...this.progressLog],
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  /** 循环外（如后台任务未捕获异常）记录一条错误。 */
  noteError(message: string): void {
    this.lastError = message
    this.pushLog(`错误：${message}`)
  }

  private pushLog(line: string): void {
    this.progressLog.push(line)
    if (this.progressLog.length > 30) this.progressLog.shift()
  }

  /** 中止正在运行的循环（boss_stop 工具调用）。 */
  stop(): boolean {
    if (!this.controller) return false
    this.controller.abort()
    return true
  }

  async run(
    page: Page,
    store: JobStore,
    jobs: JobRecord[],
    options: GreetOptions,
    externalSignal: AbortSignal,
  ): Promise<GreetSummary> {
    if (this.controller) throw new Error('已有正在运行的打招呼任务，请先调用 boss_stop')
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal
    const onExternalAbort = () => controller.abort()
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })

    const results: GreetOutcome[] = []
    let greeted = 0
    let skipped = 0
    let failed = 0
    let note: string | undefined
    this.progressProcessed = 0
    this.progressTotal = Math.min(jobs.length, options.maxCount)
    this.progressLog = []
    this.lastError = undefined
    this.pushLog(`开始打招呼任务，共 ${this.progressTotal} 个岗位`)

    try {
      const targets = jobs.slice(0, options.maxCount)
      for (const job of targets) {
        if (signal.aborted) break

        if (store.isGreeted(job.securityId)) {
          results.push({ id: job.id, jobName: job.jobName, company: job.company, status: 'already', message: '本地记录显示已沟通过，跳过' })
          skipped += 1
          this.progressProcessed += 1
          this.pushLog(`[跳过] ${job.jobName} | ${job.company}：已沟通过`)
          continue
        }
        if (store.greetedTodayCount() >= options.maxGreetPerDay) {
          note = `已达到每日沟通上限（maxGreetPerDay=${options.maxGreetPerDay}），停止投递`
          break
        }

        let outcome: GreetOutcome
        try {
          outcome = await greetOne(page, job, options.greeting, signal)
        } catch (error) {
          if (isAbortError(error)) break
          outcome = { id: job.id, jobName: job.jobName, company: job.company, status: 'failed', message: error instanceof Error ? error.message : String(error) }
        }

        results.push(outcome)
        this.progressProcessed += 1
        this.pushLog(`[${outcome.status}] ${job.jobName} | ${job.company}：${outcome.message}`)
        if (outcome.status === 'greeted' || outcome.status === 'already') {
          store.markGreeted(job.securityId)
          if (outcome.status === 'greeted') greeted += 1
          else skipped += 1
        } else if (outcome.status === 'limit') {
          note = 'Boss 提示今日沟通已达上限，停止投递'
          failed += 1
          break
        } else if (outcome.status === 'captcha') {
          note = '触发滑块/安全验证，请在浏览器窗口中手动完成后重试'
          failed += 1
          break
        } else {
          failed += 1
        }

        // 岗位间随机间隔，模拟真人
        if (!signal.aborted) {
          try {
            await randomDelay(options.delayMinSec * 1000, options.delayMaxSec * 1000, signal)
          } catch {
            break
          }
        }
      }
    } finally {
      externalSignal.removeEventListener('abort', onExternalAbort)
      this.controller = undefined
      this.pushLog(`任务结束：成功 ${greeted}，跳过 ${skipped}，失败 ${failed}`)
    }

    const stopped = signal.aborted
    return {
      total: results.length,
      greeted,
      skipped,
      failed,
      stopped,
      ...(note !== undefined ? { note } : {}),
      results,
    }
  }
}
