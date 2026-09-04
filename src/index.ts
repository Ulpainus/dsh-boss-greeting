import './host/env.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BrowserManager } from './host/browser.ts'
import { GreetRunner } from './host/greet.ts'
import { registerHttpRoutes } from './host/http.ts'
import { JobStore } from './host/store.ts'
import { registerTools } from './host/tools.ts'

/** 插件根目录（src 的上一级），userdata 与 data 的默认位置。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const name = 'boss-greeting'
export const inject = ['tools', 'webServer']

export interface Config {
  /** 默认招呼语模板，boss_greet 未传 greeting 时使用。 */
  greetingTemplate: string
  /** 岗位间最小间隔秒数。 */
  delayMinSec: number
  /** 岗位间最大间隔秒数。 */
  delayMaxSec: number
  /** 每日最多沟通岗位数，防止触发 Boss 风控。 */
  maxGreetPerDay: number
  /** 是否无头模式。Boss 有反爬，必须保持 false。 */
  headless: boolean
  /** Playwright 持久化用户数据目录（保存登录态）。 */
  userDataDir: string
}

export const Config: Schema<Config> = Schema.object({
  greetingTemplate: Schema.string().default('您好，我对贵司这个岗位很感兴趣，我的经历与岗位要求比较匹配，方便进一步沟通吗？'),
  delayMinSec: Schema.number().default(4),
  delayMaxSec: Schema.number().default(8),
  maxGreetPerDay: Schema.number().default(100),
  headless: Schema.boolean().default(false),
  userDataDir: Schema.string().default(join(PLUGIN_ROOT, 'userdata')),
})

export function apply(ctx: Context, config: Config) {
  const store = new JobStore(join(PLUGIN_ROOT, 'data'))
  const browser = new BrowserManager({ headless: config.headless, userDataDir: config.userDataDir })
  const runner = new GreetRunner()

  registerTools(ctx, { store, browser, runner, config })
  registerHttpRoutes(ctx, { store, browser, runner, config })

  // 插件卸载时关闭浏览器并中止进行中的循环
  ctx.effect(() => {
    return () => {
      runner.stop()
      void browser.dispose()
    }
  })

  console.log('[boss-greeting] plugin loaded, tools: boss_login / boss_search / boss_greet / boss_records / boss_stop, http: /boss-greeting/api/*')
}
