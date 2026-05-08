const glados = async () => {
  const notice = []

  // 通用的签到执行函数
  const doCheckin = async (cookie, domain, token) => {
    if (!cookie) return
    try {
      const common = {
        'cookie': cookie,
        'referer': `https://${domain}/console/checkin`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      }
      const action = await fetch(`https://${domain}/api/user/checkin`, {
        method: 'POST',
        headers: { ...common, 'content-type': 'application/json' },
        body: JSON.stringify({ token: token }),
      }).then((r) => r.json())
      
      if (action?.code) throw new Error(action?.message)
      
      const status = await fetch(`https://${domain}/api/user/status`, {
        method: 'GET',
        headers: { ...common },
      }).then((r) => r.json())
      
      if (status?.code) throw new Error(status?.message)
      
      notice.push(
        `[${domain}] Checkin OK`,
        `${action?.message}`,
        `Left Days ${Number(status?.data?.leftDays)}`
      )
    } catch (error) {
      notice.push(
        `[${domain}] Checkin Error`,
        `${error}`,
        `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
    }
  }

  // 1. 处理原站点 (glados.cloud) 的账号签到
  if (process.env.GLADOS) {
    for (const cookie of String(process.env.GLADOS).split('\n')) {
      if (cookie.trim()) {
        await doCheckin(cookie.trim(), 'glados.cloud', 'glados.cloud')
      }
    }
  }

  // 2. 处理新站点 (railgun.info) 的账号签到
  if (process.env.RAILGUN) {
    for (const cookie of String(process.env.RAILGUN).split('\n')) {
      if (cookie.trim()) {
        // 若签到报错 token 错误，可将下方的 'glados.network' 改回 'glados.cloud' 尝试
        await doCheckin(cookie.trim(), 'railgun.info', 'glados.network') 
      }
    }
  }

  return notice
}

// 确保包含调用执行部分
// glados().then(console.log);

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
          headers: { 'content-type': 'application/json' },
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
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option.split(':')[1],
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
      } else if (option.startsWith('qyweixin:')) {
        const qyweixinToken = option.split(':')[1]
        const qyweixinNotifyRebotUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyweixinToken;
        await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
                content: notice.join('<br>')
            }
          }),
        })
      } else {
        // fallback
        await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
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
