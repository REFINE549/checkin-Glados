
function getServerChanUrl(sendKey) {
  const key = String(sendKey || '').trim()

  // Server酱³：sctp 开头
  if (key.startsWith('sctp')) {
    const match = key.match(/^sctp(\d+)t/)

    if (!match) {
      throw new Error('Server酱³ SendKey 格式无效')
    }

    return `https://${match[1]}.push.ft07.com/send/${key}.send`
  }

  // Server酱 Turbo：SCT 开头
  if (key.startsWith('SCT')) {
    return `https://sctapi.ftqq.com/${key}.send`
  }

  throw new Error('不支持的 Server酱 SendKey 格式')
}

export async function sendServerChan(
  sendKey,
  title,
  content
) {
  if (!sendKey) {
    console.log('Server酱未配置，跳过通知')
    return false
  }

  let url

  try {
    url = getServerChanUrl(sendKey)
  } catch (error) {
    console.error(error.message)
    return false
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        desp: content,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      console.error(
        `Server酱推送失败：HTTP ${response.status}`
      )
      return false
    }

    const result = await response.json()

    if (
      !result ||
      typeof result !== 'object' ||
      result.code !== 0
    ) {
      console.error(
        `Server酱推送失败：接口返回异常（code=${result?.code ?? 'unknown'}）`
      )
      return false
    }

    console.log('Server酱推送成功')
    return true
  } catch (error) {
    // 不打印 URL，避免泄露 SendKey
    console.error(
      `Server酱推送异常：${error?.name || 'Unknown error'}`
    )
    return false
  }
}
