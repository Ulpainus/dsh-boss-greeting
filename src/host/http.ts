import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  getStatus, listRecords, openLoginPage, searchAndStore, startGreetInBackground, stopGreet,
  type Deps, type SearchParams, type StartGreetParams,
} from './actions.ts'
import type { RecordStatus } from './store.ts'
import { API_PATHS } from '../shared/api.ts'

/** 结构化出 webServer 服务类型，避免运行时 value-import dsh-host-webserver。 */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
}

const MAX_BODY_BYTES = 1024 * 1024

/**
 * 浏览器信任检查：复刻 dsh /api fence 对本 loopback 部署的判定——
 * Host 必须 loopback（防 DNS rebinding），拒绝 cross-site 标记，
 * 带 Origin 时必须与 Host 同源。非浏览器的本机调用（curl）同样只受 Host 约束。
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const { hostname } = hostUrl
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost'
    || hostname === '[::1]' || hostname.endsWith('.localhost')
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 每个端点的处理函数签名：返回要序列化的 JSON 值（或带 status）。 */
type Endpoint = (req: IncomingMessage) => Promise<{ status?: number; payload: unknown }>

/** 注册插件的 HTTP API：/boss-greeting/api/* 一组 exact 路由。 */
export function registerHttpRoutes(ctx: Context, deps: Deps): void {
  const webServer = (ctx as unknown as { webServer: WebServerLike }).webServer

  const endpoints: Record<string, { method: string; run: Endpoint }> = {
    [API_PATHS.status]: {
      method: 'GET',
      run: async () => ({ payload: await getStatus(deps) }),
    },
    [API_PATHS.login]: {
      method: 'POST',
      run: async () => ({ payload: await openLoginPage(deps) }),
    },
    [API_PATHS.search]: {
      method: 'POST',
      run: async (req) => {
        const body = await readBody(req)
        if (!isRecord(body) || typeof body.query !== 'string' || body.query.trim() === '') {
          return { status: 400, payload: { error: 'query（非空字符串）必填' } }
        }
        const params: SearchParams = {
          query: body.query.trim(),
          ...(typeof body.city === 'string' ? { city: body.city } : {}),
          ...(typeof body.salary === 'string' ? { salary: body.salary } : {}),
          ...(optionalNumber(body.maxPages) !== undefined ? { maxPages: optionalNumber(body.maxPages) } : {}),
          ...(stringArray(body.excludeKeywords) !== undefined ? { excludeKeywords: stringArray(body.excludeKeywords) } : {}),
          ...(stringArray(body.companyBlacklist) !== undefined ? { companyBlacklist: stringArray(body.companyBlacklist) } : {}),
          ...(optionalNumber(body.minSalaryK) !== undefined ? { minSalaryK: optionalNumber(body.minSalaryK) } : {}),
          ...(optionalNumber(body.maxSalaryK) !== undefined ? { maxSalaryK: optionalNumber(body.maxSalaryK) } : {}),
        }
        return { payload: await searchAndStore(deps, params, new AbortController().signal) }
      },
    },
    [API_PATHS.greet]: {
      method: 'POST',
      run: async (req) => {
        const body = await readBody(req)
        if (!isRecord(body)) {
          return { status: 400, payload: { error: 'jobIds（非空字符串数组）必填' } }
        }
        const jobIds = stringArray(body.jobIds)
        if (!jobIds || jobIds.length === 0) {
          return { status: 400, payload: { error: 'jobIds（非空字符串数组）必填' } }
        }
        const params: StartGreetParams = {
          jobIds,
          ...(typeof body.greeting === 'string' && body.greeting.trim() !== '' ? { greeting: body.greeting.trim() } : {}),
          ...(optionalNumber(body.maxCount) !== undefined ? { maxCount: optionalNumber(body.maxCount) } : {}),
        }
        return { payload: startGreetInBackground(deps, params) }
      },
    },
    [API_PATHS.stop]: {
      method: 'POST',
      run: async () => ({ payload: stopGreet(deps) }),
    },
    [API_PATHS.records]: {
      method: 'GET',
      run: async (req) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const status = url.searchParams.get('status') ?? 'all'
        if (!['all', 'ungreeted', 'greeted'].includes(status)) {
          return { status: 400, payload: { error: 'status 只能是 all / ungreeted / greeted' } }
        }
        return { payload: listRecords(deps, status as RecordStatus) }
      },
    },
  }

  for (const [path, endpoint] of Object.entries(endpoints)) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, { error: 'forbidden' })
          return
        }
        if (req.method !== endpoint.method) {
          sendJson(res, 405, { error: `method not allowed, use ${endpoint.method}` })
          return
        }
        try {
          const { status = 200, payload } = await endpoint.run(req)
          sendJson(res, status, payload)
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `boss-greeting: http ${path}`)
  }
}
