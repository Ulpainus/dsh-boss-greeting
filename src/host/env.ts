/**
 * 必须在任何 patchright import 之前执行的副作用模块。
 *
 * 浏览器二进制查找顺序：
 * 1. 环境变量 PLAYWRIGHT_BROWSERS_PATH（用户显式设置，优先级最高，不覆盖）
 * 2. patchright/playwright 默认目录（Windows: %LOCALAPPDATA%\ms-playwright）
 * 3. 常见自定义位置（D:\playwright-browsers，仅在该目录确实存在时使用）
 *
 * 都没有时不设变量，让 patchright 报出标准的 "please run npx patchright install" 错误。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function hasChromium(dir: string): boolean {
  try {
    return readdirSync(dir).some(entry => /^chromium-\d+$/.test(entry))
  } catch {
    return false
  }
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const defaultDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : ''
  if (!defaultDir || !hasChromium(defaultDir)) {
    for (const candidate of ['D:\\playwright-browsers']) {
      if (existsSync(candidate) && hasChromium(candidate)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = candidate
        break
      }
    }
  }
}
