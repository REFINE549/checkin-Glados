
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { sendServerChan } from './notifier.js'

const CONFIG = {
  challengeWaitMs: 2700,
  maxAttempts: 3,
  retryDelayMs: 60000,
  requestTimeoutMs: 15000,
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms))

class RequestError extends Error {
  constructor(message, status = null, retryable = true) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.retryable = retryable
  }
}

function safeError(error) {
  if (error?.status) return `HTTP ${error.status}`

  const message = String(error?.message || 'Unknown error')

  if (/cookie|token|nonce|proof|authorization|sendkey/i.test(message)) {
    return '请求失败，敏感错误信息已隐藏'
  }

  return message.slice(0, 180)
}

function isAuthDenied(error) {
  return (
    error?.status === 401 ||
    error?.status === 403 ||
    /device-mismatch|automated check-in detected|unauthorized|没有权限/i.test(
      String(error?.message || '')
    )
  )
}

// -------------------- 签到结果识别 --------------------

function getCheckinResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      success: false,
      alreadyChecked: false,
    }
  }

  const message = String(result.message || '').toLowerCase()

  const alreadyChecked =
    message.includes('already checked in today') ||
    message.includes('checkin repeats! please try tomorrow')

  const successMessages = [
    'checkin! got',
    "today's observation logged",
    'already checked in today',
    'checkin repeats! please try tomorrow',
  ]

  const success =
    successMessages.some((item) => message.includes(item)) ||
    result.code === 0

  return {
    success,
    alreadyChecked,
  }
}

// -------------------- HTTP 请求 --------------------

async function requestJson(url, options = {}) {
  let response

  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    })
  } catch (error) {
    const timeout =
      error?.name === 'TimeoutError' ||
      error?.name === 'AbortError'

    throw new RequestError(
      timeout ? 'Request timeout' : 'Network request failed'
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new RequestError(
      'Authentication rejected',
      response.status,
      false
    )
  }

  if (response.status === 404) {
    throw new RequestError('HTTP 404', 404, false)
  }

  let data

  try {
    data = await response.json()
  } catch {
    throw new RequestError(
      `Invalid JSON response (HTTP ${response.status})`,
      response.status,
      response.status >= 500 || response.status === 429
    )
  }

  if (!response.ok) {
    throw new RequestError(
      `HTTP ${response.status}`,
      response.status,
      response.status >= 500 || response.status === 429
    )
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequestError('Invalid API response')
  }

  return data
}

// -------------------- GLaDOS Client --------------------

class GladosClient {
  constructor({ cookie, domain, userAgent }) {
    this.cookie = cookie
    this.origin = `https://${domain}`
    this.domain = domain
    this.userAgent = userAgent || DEFAULT_USER_AGENT

    this.email = '未获取'
    this.leftDays = '未获取'
    this.points = '未获取'
    this.pointsChange = '未获取'
  }

  get headers() {
    return {
      Cookie: this.cookie,
      Origin: this.origin,
      Referer: `${this.origin}/console/checkin`,
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/plain, */*',
    }
  }

  async request(path, options = {}) {
    return requestJson(`${this.origin}${path}`, {
      ...options,
      headers: {
        ...this.headers,
        ...(options.headers || {}),
      },
    })
  }

  // --------------------
  // 签到请求
  // --------------------

  async checkinOnce() {

    // Railgun：使用旧版直接签到协议
    if (this.domain === 'railgun.info') {
      console.log(
        '[railgun.info] Using legacy check-in protocol'
      )

      return this.request('/api/user/checkin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'glados.network',
        }),
      })
    }

    // GLaDOS：新版 Challenge 认证协议
    const challenge = await this.request(
      '/api/user/checkin/challenge',
      { method: 'GET' }
    )

    if (challenge.code !== 0) {
      throw new RequestError(
        'Challenge authentication rejected',
        null,
        false
      )
    }

    const nonce = challenge.nonce
    const ttl = challenge.ttl ?? 300000

    if (
      typeof nonce !== 'string' ||
      nonce.length === 0 ||
      nonce.length > 4096 ||
      typeof ttl !== 'number' ||
      !Number.isFinite(ttl) ||
      ttl <= CONFIG.challengeWaitMs
    ) {
      throw new RequestError('Invalid Challenge')
    }

    const receivedAt = performance.now()

    const proof = createHash('sha256')
      .update(`${nonce}.glados-observe-v1`, 'utf8')
      .digest('hex')

    await sleep(CONFIG.challengeWaitMs)

    const elapsed = performance.now() - receivedAt

    if (elapsed >= ttl) {
      throw new RequestError('Challenge expired')
    }

    return this.request('/api/user/checkin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: new URL(this.origin).hostname,
        nonce,
        proof,
      }),
    })
  }

  // --------------------
  // 签到及重试
  // --------------------

  async checkin() {
    let lastError

    for (
      let attempt = 1;
      attempt <= CONFIG.maxAttempts;
      attempt++
    ) {
      console.log(
        `[${this.domain}] Check-in ${attempt}/${CONFIG.maxAttempts}`
      )

      try {
        const result = await this.checkinOnce()
        const status = getCheckinResult(result)

        if (status.success) {
          return {
            success: true,
            alreadyChecked: status.alreadyChecked,
            message: result.message || 'Check-in completed',
          }
        }

        lastError = new RequestError(
          result.message || `Check-in failed (code=${result.code})`,
          null,
          true
        )

      } catch (error) {
        lastError = error

        console.log(
          `[${this.domain}] ${safeError(error)}`
        )

        if (
          isAuthDenied(error) ||
          error.retryable === false
        ) {
          break
        }
      }

      if (attempt < CONFIG.maxAttempts) {
        console.log(
          `[${this.domain}] Retry in ${CONFIG.retryDelayMs / 1000}s`
        )

        await sleep(CONFIG.retryDelayMs)
      }
    }

    return {
      success: false,
      alreadyChecked: false,
      message: safeError(lastError || new Error('Check-in failed')),
    }
  }

  // --------------------
  // 查询账户状态
  // --------------------

  async getStatus() {
    const result = await this.request('/api/user/status', {
      method: 'GET',
    })

    if (result.code !== 0 || !result.data) {
      throw new RequestError('Status query failed')
    }

    this.email = result.data.email || '未获取'
    this.leftDays = result.data.leftDays ?? '未获取'
  }

  // --------------------
  // 查询积分
  // --------------------

  async getPoints() {
    const result = await this.request('/api/user/points', {
      method: 'GET',
    })

    if (typeof result.points === 'undefined') {
      throw new RequestError('Points query failed')
    }

    this.points = result.points

    const history = Array.isArray(result.history)
      ? result.history
      : []

    if (history.length > 0) {
      const change = Number(history[0].change)

      if (Number.isFinite(change)) {
        this.pointsChange =
          change > 0 ? `+${change}` : String(change)
      }
    }
  }
}

// -------------------- 账号配置 --------------------

function getAccounts() {
  const accounts = []

  const gladosCookies = String(
    process.env.GLADOS || ''
  )
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

  for (const cookie of gladosCookies) {
    accounts.push({
      cookie,
      domain: 'glados.cloud',
      userAgent:
        process.env.GLADOS_USER_AGENT || DEFAULT_USER_AGENT,
    })
  }

  const railgunCookies = String(
    process.env.RAILGUN || ''
  )
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

  for (const cookie of railgunCookies) {
    accounts.push({
      cookie,
      domain: 'railgun.info',
      userAgent:
        process.env.RAILGUN_USER_AGENT || DEFAULT_USER_AGENT,
    })
  }

  return accounts
}

// -------------------- 执行单个账号 --------------------

async function runAccount(account, index) {
  const client = new GladosClient(account)

  const result = {
    index,
    domain: account.domain,
    success: false,
    alreadyChecked: false,
    message: '',
    email: '未获取',
    points: '未获取',
    pointsChange: '未获取',
    leftDays: '未获取',
    detailError: '',
  }

  const checkinResult = await client.checkin()

  result.success = checkinResult.success
  result.alreadyChecked = checkinResult.alreadyChecked
  result.message = checkinResult.message

  // 签到成功或今日已经签到，都查询账户状态
  if (result.success) {
    try {
      await client.getStatus()
    } catch (error) {
      result.detailError +=
        `状态查询失败：${safeError(error)}；`
    }

    try {
      await client.getPoints()
    } catch (error) {
      result.detailError +=
        `积分查询失败：${safeError(error)}；`
    }
  }

  result.email = client.email
  result.points = client.points
  result.pointsChange = client.pointsChange
  result.leftDays = client.leftDays

  console.log(
    `[${account.domain}] Account ${index}: ${
      result.success ? 'SUCCESS' : 'FAILED'
    }`
  )

  console.log(`签到结果：${result.message}`)
  console.log(`积分：${result.points}`)
  console.log(`剩余天数：${result.leftDays}`)

  return result
}

// -------------------- 汇总报告 --------------------

function buildReport(results) {
  const successCount = results.filter(
    (item) => item.success
  ).length

  const total = results.length
  const allSuccess = successCount === total

  const title = allSuccess
    ? `GLaDOS签到成功 ${successCount}/${total}`
    : `GLaDOS签到异常 ${successCount}/${total}`

  const lines = [
    '## GLaDOS 自动签到报告',
    '',
    `**运行结果：** ${allSuccess ? '全部成功' : '存在失败'}`,
    `**成功账号：** ${successCount}/${total}`,
    '',
  ]

  for (const item of results) {
    lines.push(
      `### 账号 ${item.index} (${item.domain})`,
      '',
      `- 签到状态：${item.success ? (item.alreadyChecked ? '今日已签到' : '成功') : '失败'}`,
      `- 签到结果：${item.message}`,
      `- 当前积分：${item.points}`,
      `- 积分变化：${item.pointsChange}`,
      `- 剩余天数：${item.leftDays}`,
    )

    if (item.detailError) {
      lines.push(`- 附加信息：${item.detailError}`)
    }

    lines.push('')
  }

  lines.push(
    '---',
    `运行时间：${new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    })} (UTC+8)`
  )

  return {
    title,
    content: lines.join('\n'),
    successCount,
    total,
    allSuccess,
  }
}

// -------------------- 主程序 --------------------

async function main() {
  console.log(
    '[Config] ServerChan:',
    process.env.SERVERCHAN_SENDKEY
      ? 'Secret loaded'
      : 'Secret missing'
  )

  const accounts = getAccounts()

  if (accounts.length === 0) {
    console.error(
      'No accounts configured. Please set GLADOS or RAILGUN.'
    )
    process.exitCode = 1
    return
  }

  console.log(`共检测到 ${accounts.length} 个账号`)

  const results = []

  for (let i = 0; i < accounts.length; i++) {
    try {
      const result = await runAccount(accounts[i], i + 1)
      results.push(result)

    } catch (error) {
      results.push({
        index: i + 1,
        domain: accounts[i].domain,
        success: false,
        alreadyChecked: false,
        message: safeError(error),
        email: '未获取',
        points: '未获取',
        pointsChange: '未获取',
        leftDays: '未获取',
        detailError: '',
      })
    }
  }

  const report = buildReport(results)

  console.log('\n' + report.content)

  // Server酱通知
  const pushLevel = (
    process.env.PUSH_LEVEL || 'fail_only'
  ).trim().toLowerCase()

  const shouldPush =
    pushLevel === 'all' ||
    (pushLevel === 'fail_only' && !report.allSuccess)

  if (shouldPush) {
    const sendKey = process.env.SERVERCHAN_SENDKEY

    if (!sendKey) {
      console.error(
        'SERVERCHAN_SENDKEY is not configured; notification skipped.'
      )
    } else {
      try {
        await sendServerChan(
          sendKey,
          report.title,
          report.content
        )

        console.log('Server酱推送成功')
      } catch (error) {
        console.error(
          `Server酱推送失败：${safeError(error)}`
        )
      }
    }
  } else {
    console.log(
      'All accounts succeeded; notification skipped (PUSH_LEVEL=fail_only).'
    )
  }

  // 只有真正签到失败的账号才导致 Actions 失败
  if (!report.allSuccess) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${safeError(error)}`)
  process.exitCode = 1
})
