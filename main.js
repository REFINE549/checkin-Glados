const glados = async () => {
  const notice = []

  const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

  // 判断新版 GLaDOS 的签到结果是否属于正常结果
  const isNormalCheckinResult = (result) => {
    if (!result || typeof result !== 'object') return false

    const message = String(result?.message || '').trim().toLowerCase()

    const normalMessages = [
      'checkin! got',
      'checkin repeats! please try tomorrow',
      "today's observation logged",
    ]

    if (normalMessages.some((marker) => message.includes(marker))) {
      return true
    }

    // 历史及当前版本的正常成功返回
    return result?.code === 0
  }

  // 通用 JSON 请求
  const requestJson = async (url, options = {}) => {
    const response = await fetch(url, options)

    const text = await response.text()

    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        `HTTP ${response.status}: ${text.slice(0, 200) || 'Invalid JSON response'}`
      )
    }

    if (!response.ok) {
      throw new Error(
        data?.message || `HTTP ${response.status}`
      )
    }

    return data
  }

  // 通用的签到执行函数
  const doCheckin = async (
    cookie,
    domain,
    token,
    userAgent = DEFAULT_USER_AGENT
  ) => {
    if (!cookie) return

    try {
      const common = {
        'cookie': cookie,
        'origin': `https://${domain}`,
        'referer': `https://${domain}/console/checkin`,
        'user-agent': userAgent,
        'accept': 'application/json, text/plain, */*',
      }

      let action = null
      let lastError = null

      // 签到失败时最多重试 3 次
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          action = await requestJson(
            `https://${domain}/api/user/checkin`,
            {
              method: 'POST',
              headers: {
                ...common,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                token: token,
              }),
            }
          )

          // 新版 GLaDOS 的“重复签到”也属于正常结果
          if (isNormalCheckinResult(action)) {
            break
          }

          lastError = new Error(
            action?.message ||
            `Checkin failed (code=${action?.code})`
          )
        } catch (error) {
          lastError = error
        }

        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 60000))
        }
      }

      // 三次均未得到正常结果
      if (!isNormalCheckinResult(action)) {
        throw lastError ||
          new Error('Checkin failed')
      }

      // 签到成功后再查询状态
      const status = await requestJson(
        `https://${domain}/api/user/status`,
        {
          method: 'GET',
          headers: {
            ...common,
          },
        }
      )

      if (status?.code) {
        throw new Error(
          status?.message || `Status request failed (code=${status?.code})`
        )
      }

      notice.push(
        `[${domain}] Checkin OK`,
        `${action?.message || ''}`,
        `Left Days ${Number(status?.data?.leftDays ?? 0)}`
      )
    } catch (error) {
      notice.push(
        `[${domain}] Checkin Error`,
        `${error?.message || error}`,
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }

  // 1. 处理原站点 (glados.cloud) 的账号签到
  if (process.env.GLADOS) {
    for (const cookie of String(process.env.GLADOS).split('\n')) {
      if (cookie.trim()) {
        await doCheckin(
          cookie.trim(),
          'glados.cloud',
          'glados.cloud',
          process.env.GLADOS_USER_AGENT || DEFAULT_USER_AGENT
        )
      }
    }
  }

  // 2. 处理新站点 (railgun.info) 的账号签到
  if (process.env.RAILGUN) {
    for (const cookie of String(process.env.RAILGUN).split('\n')) {
      if (cookie.trim()) {
        // 若签到报错 token 错误，可将下方的 'glados.network' 改回 'glados.cloud' 尝试
        await doCheckin(
          cookie.trim(),
          'railgun.info',
          'glados.network',
          process.env.RAILGUN_USER_AGENT || DEFAULT_USER_AGENT
        )
      }
    }
  }

  return notice
}

const notify = async (notice) => {
  if (!process.env.NOTIFY || !notice) return

  for (const option of String(process.env.NOTIFY).split('\n')) {
    if (!option) continue

    try {
      if (option.startsWith('console:')) {
        for (const line of notice) {
          console.log(line)
        }
      } else if (option.startsWith('wxpusher:')) {
        await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            appToken: option.split(':')[1],
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: option.split(':').slice(2),
          }),
        })
      } else if (option.startsWith('pushplus:')) {
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]

        const qyweixinNotifyRebotUrl =
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' +
          qyweixinToken

        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
              content: notice.join('<br>'),
            },
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      }
    } catch (error) {
      throw error
    }
  }
}

const main = async () => {
  await notify(await glados())
}

main()
