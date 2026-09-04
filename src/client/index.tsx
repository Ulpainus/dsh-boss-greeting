/**
 * boss-greeting 浏览器端控制面板：挂在 shell.overlay 悬浮层 slot。
 * 与 host 侧通过 /boss-greeting/api/* HTTP 端点通信（路径与类型见 src/shared/api.ts）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_PATHS, type JobItem, type StatusPayload } from '../shared/api.ts'
import CITIES_RAW from '../shared/cities.json'

interface SlotsLike {
  inject(name: string, cb: () => unknown): void
  register(entry: Record<string, unknown>, component: unknown): unknown
}

export const inject = ['slots']

export function apply(ctx: unknown) {
  const slots = (ctx as { slots: SlotsLike }).slots
  // shell.overlay 是 list 型 slot，additive；必须先 inject 声明依赖再注册
  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'boss-greeting', order: 50, inject: () => ({}) },
    BossPanel,
  ))
}

interface City {
  name: string
  code: string
  pinyin: string
  firstChar: string
}

const CITIES = CITIES_RAW as City[]

/** 可搜索城市选择器：输入即过滤（名称/拼音/首字母），失焦收起。 */
function CityPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const selected = CITIES.find(c => c.code === value)
  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? CITIES.filter(c => c.name.includes(keyword.trim()) || c.pinyin.toLowerCase().includes(kw) || c.firstChar.toLowerCase() === kw)
    : CITIES
  return (
    <div style={{ position: 'relative', width: 96, flexShrink: 0 }}>
      <input
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
        placeholder="城市"
        value={open ? keyword : (selected?.name ?? '')}
        onFocus={() => { setOpen(true); setKeyword('') }}
        onChange={e => { setKeyword(e.target.value); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        title={selected ? `${selected.name} (${selected.code})` : ''}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10000,
          maxHeight: 220, overflowY: 'auto', marginTop: 2,
          background: '#1e2128', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
        }}>
          {filtered.slice(0, 80).map(c => (
            <div
              key={c.code}
              onMouseDown={() => { onChange(c.code); setOpen(false) }}
              style={{
                padding: '5px 8px', fontSize: 12, cursor: 'pointer',
                color: c.code === value ? '#4dabf7' : '#e6e8ec',
                background: c.code === value ? 'rgba(77,171,247,0.12)' : undefined,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = c.code === value ? 'rgba(77,171,247,0.12)' : '' }}
            >
              {c.name}
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: '6px 8px', fontSize: 12, color: '#9aa0a6' }}>无匹配城市</div>}
          {filtered.length > 80 && <div style={{ padding: '4px 8px', fontSize: 11, color: '#9aa0a6' }}>还有 {filtered.length - 80} 个，输入关键字缩小范围</div>}
        </div>
      )}
    </div>
  )
}

// ---------- API ----------

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
  return data as T
}

// ---------- 样式 ----------

const colors = {
  bg: 'rgba(18, 20, 26, 0.88)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  text: '#e8e8ec',
  dim: '#9a9aa5',
  accent: '#4f8cff',
  green: '#3fce7c',
  gray: '#777',
  danger: '#ff6b6b',
}

const panelStyle: React.CSSProperties = {
  position: 'fixed', right: 16, bottom: 16, zIndex: 9999,
  width: 400, maxHeight: '72vh', display: 'flex', flexDirection: 'column',
  background: colors.bg, border: colors.border, borderRadius: 12,
  backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
  color: colors.text, fontSize: 12, fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
  boxShadow: '0 8px 32px rgba(0,0,0,0.45)', pointerEvents: 'auto', overflow: 'hidden',
}

const sectionStyle: React.CSSProperties = {
  padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const sectionTitle: React.CSSProperties = {
  fontWeight: 600, fontSize: 12, marginBottom: 6, color: colors.dim,
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6, color: colors.text, padding: '4px 6px', fontSize: 12, outline: 'none',
}

const buttonStyle: React.CSSProperties = {
  background: colors.accent, border: 'none', borderRadius: 6, color: '#fff',
  padding: '5px 12px', fontSize: 12, cursor: 'pointer',
}

const ghostButtonStyle: React.CSSProperties = {
  ...buttonStyle, background: 'rgba(255,255,255,0.1)', color: colors.text,
}

function Dot({ on }: { on: boolean }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: on ? colors.green : colors.gray, marginRight: 6,
  }} />
}

// ---------- 面板组件 ----------

function BossPanel() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [city, setCity] = useState('100010000')
  const [minSalaryK, setMinSalaryK] = useState('')
  const [maxSalaryK, setMaxSalaryK] = useState('')
  const [excludeKeywords, setExcludeKeywords] = useState('')
  const [companyBlacklist, setCompanyBlacklist] = useState('')
  const [maxPages, setMaxPages] = useState('3')
  const [searching, setSearching] = useState(false)
  const [jobs, setJobs] = useState<JobItem[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [greeting, setGreeting] = useState('')
  const [maxCount, setMaxCount] = useState('10')
  const [records, setRecords] = useState<JobItem[]>([])
  const [showRecords, setShowRecords] = useState(false)
  const [toast, setToast] = useState('')
  const statusRef = useRef<StatusPayload | null>(null)
  statusRef.current = status

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<StatusPayload>(API_PATHS.status)
      setStatus(data)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 轮询：任务运行中 2s，空闲 10s
  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => {
      void refreshStatus()
    }, status?.greet.running ? 2000 : 10000)
    return () => clearInterval(timer)
  }, [refreshStatus, status?.greet.running])

  // 首次拿到默认招呼语时填入
  useEffect(() => {
    if (status && greeting === '') setGreeting(status.defaults.greetingTemplate)
  }, [status, greeting])

  const notify = (message: string) => {
    setToast(message)
    setTimeout(() => setToast(''), 4000)
  }

  const doLogin = async () => {
    try {
      const result = await api<{ loggedIn: boolean; message: string }>(API_PATHS.login, {})
      notify(result.message)
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const doSearch = async () => {
    if (query.trim() === '') { setError('请输入搜索关键词'); return }
    setSearching(true)
    setError('')
    try {
      const result = await api<{ jobs: JobItem[]; count: number; note?: string }>(API_PATHS.search, {
        query: query.trim(),
        city,
        maxPages: Number(maxPages) || 3,
        ...(minSalaryK !== '' ? { minSalaryK: Number(minSalaryK) } : {}),
        ...(maxSalaryK !== '' ? { maxSalaryK: Number(maxSalaryK) } : {}),
        excludeKeywords: excludeKeywords.split(/[,，]/).map(s => s.trim()).filter(Boolean),
        companyBlacklist: companyBlacklist.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      })
      setJobs(result.jobs)
      setSelected({})
      notify(`找到 ${result.count} 个岗位${result.note ? `（${result.note}）` : ''}`)
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setSearching(false) }
  }

  const selectedIds = jobs.filter(j => selected[j.id]).map(j => j.id)

  const doGreet = async () => {
    if (selectedIds.length === 0) { setError('请先勾选要打招呼的岗位'); return }
    try {
      const result = await api<{ started: boolean; message: string }>(API_PATHS.greet, {
        jobIds: selectedIds,
        greeting,
        maxCount: Number(maxCount) || 10,
      })
      notify(result.message)
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const doStop = async () => {
    try {
      const result = await api<{ message: string }>(API_PATHS.stop, {})
      notify(result.message)
      await refreshStatus()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const loadRecords = async () => {
    try {
      const result = await api<{ jobs: JobItem[] }>(`${API_PATHS.records}?status=greeted`)
      setRecords(result.jobs)
      setShowRecords(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const toggleAll = (value: boolean) => {
    const next: Record<string, boolean> = {}
    if (value) for (const j of jobs) if (!j.greeted) next[j.id] = true
    setSelected(next)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 9999, pointerEvents: 'auto',
          width: 48, height: 48, borderRadius: '50%', border: colors.border,
          background: colors.bg, backdropFilter: 'blur(14px)', color: colors.text,
          fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
        title="Boss 直聘投简历面板"
      >Boss</button>
    )
  }

  const greet = status?.greet

  return (
    <div style={panelStyle}>
      {/* 头部 */}
      <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700 }}>Boss 直聘 · 半自动投简历</span>
        <button style={ghostButtonStyle} onClick={() => setOpen(false)}>收起</button>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {/* 状态区 */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>状态</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span><Dot on={status?.loggedIn ?? false} />{status?.loggedIn ? '已登录' : '未登录'}</span>
            <span><Dot on={status?.browserLaunched ?? false} />{status?.browserLaunched ? '浏览器已启动' : '浏览器未启动'}</span>
            <span style={{ color: colors.dim }}>今日已沟通 {status?.counts.greetedToday ?? 0} / 上限 {status?.defaults.maxGreetPerDay ?? '-'}</span>
          </div>
          {status && !status.loggedIn && (
            <div style={{ marginTop: 6 }}>
              <button style={buttonStyle} onClick={() => { void doLogin() }}>打开浏览器登录</button>
              <span style={{ color: colors.dim, marginLeft: 8 }}>在弹出的窗口中扫码，状态会自动更新</span>
            </div>
          )}
          {greet && (greet.running || greet.log.length > 0) && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: greet.running ? colors.accent : colors.dim }}>
                {greet.running ? `投递中 ${greet.processed}/${greet.total}` : `上次任务 ${greet.processed}/${greet.total}`}
              </div>
              <div style={{
                marginTop: 4, maxHeight: 90, overflowY: 'auto', background: 'rgba(0,0,0,0.25)',
                borderRadius: 6, padding: '4px 6px', fontSize: 11, color: colors.dim, whiteSpace: 'pre-wrap',
              }}>
                {greet.log.slice(-8).join('\n')}
              </div>
              {greet.lastError && <div style={{ color: colors.danger, marginTop: 4 }}>{greet.lastError}</div>}
            </div>
          )}
        </div>

        {/* 搜索区 */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>搜索岗位</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="关键词，如 前端工程师" value={query}
              onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doSearch() }} />
            <CityPicker value={city} onChange={setCity} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="排除关键词（逗号分隔）" value={excludeKeywords} onChange={e => setExcludeKeywords(e.target.value)} />
            <input style={{ ...inputStyle, flex: 1 }} placeholder="公司黑名单（逗号分隔）" value={companyBlacklist} onChange={e => setCompanyBlacklist(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input style={{ ...inputStyle, width: 60 }} placeholder="最低K" value={minSalaryK} onChange={e => setMinSalaryK(e.target.value)} />
            <input style={{ ...inputStyle, width: 60 }} placeholder="最高K" value={maxSalaryK} onChange={e => setMaxSalaryK(e.target.value)} />
            <input style={{ ...inputStyle, width: 56 }} placeholder="翻页数" value={maxPages} onChange={e => setMaxPages(e.target.value)} />
            <span style={{ flex: 1 }} />
            <button style={buttonStyle} disabled={searching} onClick={() => { void doSearch() }}>
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>
        </div>

        {/* 结果清单 */}
        {jobs.length > 0 && (
          <div style={sectionStyle}>
            <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between' }}>
              <span>搜索结果（{selectedIds.length}/{jobs.length} 已选）</span>
              <span>
                <button style={{ ...ghostButtonStyle, padding: '2px 8px', marginRight: 4 }} onClick={() => toggleAll(true)}>全选</button>
                <button style={{ ...ghostButtonStyle, padding: '2px 8px' }} onClick={() => toggleAll(false)}>清空</button>
              </span>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {jobs.map(job => (
                <label key={job.id} style={{
                  display: 'flex', gap: 6, alignItems: 'flex-start', padding: '4px 2px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: job.greeted ? 'default' : 'pointer',
                  opacity: job.greeted ? 0.5 : 1,
                }}>
                  <input type="checkbox" disabled={job.greeted} checked={selected[job.id] ?? false}
                    onChange={e => setSelected(prev => ({ ...prev, [job.id]: e.target.checked }))} />
                  <span style={{ flex: 1 }}>
                    <div>{job.jobName} <span style={{ color: colors.accent }}>{job.salary}</span></div>
                    <div style={{ color: colors.dim, fontSize: 11 }}>
                      {job.company} · {job.city} · {job.bossActive || '活跃未知'}
                      {job.tags.length > 0 && ` · ${job.tags.slice(0, 4).join(' / ')}`}
                      {job.greeted && ' · 已沟通'}
                    </div>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 打招呼区 */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>打招呼</div>
          <textarea
            style={{ ...inputStyle, width: '100%', minHeight: 56, resize: 'vertical', boxSizing: 'border-box' }}
            value={greeting} onChange={e => setGreeting(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <span style={{ color: colors.dim }}>每次最多</span>
            <input style={{ ...inputStyle, width: 48 }} value={maxCount} onChange={e => setMaxCount(e.target.value)} />
            <span style={{ color: colors.dim }}>
              个 · 间隔 {status?.defaults.delayMinSec ?? 4}~{status?.defaults.delayMaxSec ?? 8}s 随机
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={buttonStyle} onClick={() => { void doGreet() }} disabled={greet?.running}>
              对选中岗位打招呼
            </button>
            <button style={{ ...ghostButtonStyle, color: colors.danger }} onClick={() => { void doStop() }} disabled={!greet?.running}>
              停止
            </button>
          </div>
        </div>

        {/* 记录区 */}
        <div style={sectionStyle}>
          <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between' }}>
            <span>已沟通记录（{status?.counts ? status.counts.total - status.counts.ungreeted : 0}）</span>
            <button style={{ ...ghostButtonStyle, padding: '2px 8px' }} onClick={() => { void loadRecords() }}>
              {showRecords ? '刷新' : '查看'}
            </button>
          </div>
          {showRecords && (
            <div style={{ maxHeight: 140, overflowY: 'auto', fontSize: 11, color: colors.dim }}>
              {records.length === 0 && <div>暂无已沟通记录</div>}
              {records.map(job => (
                <div key={job.id} style={{ padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {job.jobName} | {job.company} | {job.salary}
                  {job.greetedAt && <span> · {(job.greetedAt).slice(0, 16).replace('T', ' ')}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 提示条 */}
      {(error || toast) && (
        <div style={{
          padding: '6px 12px', fontSize: 11,
          color: error ? colors.danger : colors.green,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          {error || toast}
        </div>
      )}
    </div>
  )
}
