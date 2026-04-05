import CryptoES from 'crypto-es'

const QR_CODE_API = 'https://api.extscreen.com/aliyundrive/qrcode'
const TOKEN_API = 'https://api.extscreen.com/aliyundrive/v3/token'
const QR_STATUS_API = 'https://openapi.alipan.com/oauth/qrcode'
const OAUTH_AUTHORIZE_URL = 'https://www.alipan.com/o/oauth/authorize'
const SCOPES = ['user:base', 'file:all:read', 'file:all:write'].join(',')

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      })
    }

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return renderPage(url)
      }

      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204 })
      }

      if (request.method === 'POST' && url.pathname === '/api/alipan-tv-token/generate-qr') {
        return handleGenerateQr()
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/alipan-tv-token/check-status/')) {
        const sid = decodeURIComponent(url.pathname.replace('/api/alipan-tv-token/check-status/', '').trim())
        return handleCheckStatus(sid)
      }

      if (request.method === 'POST' && url.pathname === '/api/oauth/alipan/token') {
        return handleRefreshTokenPost(request)
      }

      if (request.method === 'GET' && url.pathname === '/api/oauth/alipan/token') {
        return handleRefreshTokenGet(url)
      }

      return json(
        {
          code: 404,
          message: 'Not Found',
          data: null,
        },
        404
      )
    } catch (error) {
      return json(
        {
          code: 500,
          message: getErrorMessage(error),
          data: null,
        },
        500
      )
    }
  },
}

async function handleGenerateQr() {
  const response = await fetch(QR_CODE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      scopes: SCOPES,
      width: 500,
      height: 500,
    }),
  })

  if (!response.ok) {
    throw new Error('初始化授权链接失败')
  }

  const result = await response.json()

  return json({
    qr_link: result?.data?.qrCodeUrl ?? '',
    sid: result?.data?.sid ?? '',
  })
}

async function handleCheckStatus(sid) {
  if (!sid) {
    return json(
      {
        error: 'sid is required',
      },
      400
    )
  }

  const statusResponse = await fetch(`${QR_STATUS_API}/${encodeURIComponent(sid)}/status`)

  if (!statusResponse.ok) {
    throw new Error('查询扫码状态失败')
  }

  const statusData = await statusResponse.json()

  if (statusData.status === 'LoginSuccess' && statusData.authCode) {
    try {
      const tokenInfo = await getTokenInfo({
        code: statusData.authCode,
      })

      return json({
        status: 'LoginSuccess',
        refresh_token: tokenInfo.refresh_token,
        access_token: tokenInfo.access_token,
      })
    } catch {
      return json({
        status: 'LoginFailed',
      })
    }
  }

  return json(statusData)
}

async function handleRefreshTokenPost(request) {
  logRefreshTokenStep('request_received')

  let body = {}
  let refreshTokenValue = ''

  try {
    body = await request.json()
    logRefreshTokenStep('request_body_parsed')
  } catch (error) {
    logRefreshTokenStep(
      'request_body_parse_failed',
      {
        error: getErrorMessage(error),
      },
      'warn'
    )
  }

  refreshTokenValue = body?.refresh_token

  if (!refreshTokenValue) {
    logRefreshTokenStep('missing_refresh_token', {}, 'warn')
    return json(
      {
        code: 400,
        message: 'refresh_token is required',
        data: null,
      },
      400
    )
  }

  try {
    logRefreshTokenStep('refresh_started', {
      refresh_token_masked: maskToken(refreshTokenValue),
      refresh_token_length: refreshTokenValue.length,
    })

    const tokenInfo = await getTokenInfo({
      refresh_token: refreshTokenValue,
    })

    logRefreshTokenStep('refresh_succeeded', {
      refresh_token_masked: maskToken(tokenInfo.refresh_token),
      access_token_present: Boolean(tokenInfo.access_token),
      refresh_token_rotated: tokenInfo.refresh_token !== refreshTokenValue,
      expires_in: tokenInfo.expires_in ?? null,
    })

    return json({
      token_type: 'Bearer',
      access_token: tokenInfo.access_token,
      refresh_token: tokenInfo.refresh_token,
      expires_in: tokenInfo.expires_in,
    })
  } catch (error) {
    logRefreshTokenStep(
      'refresh_failed',
      {
        refresh_token_masked: maskToken(refreshTokenValue),
        refresh_token_length: refreshTokenValue.length,
        error: getErrorMessage(error),
      },
      'error'
    )

    return json(
      {
        code: 500,
        message: getErrorMessage(error),
        data: null,
      },
      500
    )
  }
}

async function handleRefreshTokenGet(url) {
  const refreshTokenValue = url.searchParams.get('refresh_ui')

  if (!refreshTokenValue) {
    return json({
      refresh_token: '',
      access_token: '',
      text: 'refresh_ui parameter is required',
    })
  }

  try {
    const tokenInfo = await getTokenInfo({
      refresh_token: refreshTokenValue,
    })

    return json({
      refresh_token: tokenInfo.refresh_token,
      access_token: tokenInfo.access_token,
      text: '',
    })
  } catch (error) {
    return json({
      refresh_token: '',
      access_token: '',
      text: getErrorMessage(error),
    })
  }
}

async function getTokenInfo(extraPayload) {
  const isRefreshTokenFlow = Boolean(extraPayload?.refresh_token)
  const t = Math.floor(Date.now() / 1000)
  const sendData = {
    ...getParams(t),
    ...extraPayload,
    'Content-Type': 'application/json',
  }

  const headers = Object.fromEntries(
    Object.entries(sendData).map(([key, value]) => [key, String(value)])
  )

  if (isRefreshTokenFlow) {
    logRefreshTokenStep('upstream_request_prepared', {
      refresh_token_masked: maskToken(extraPayload.refresh_token),
      refresh_token_length: extraPayload.refresh_token.length,
    })
  }

  const tokenResponse = await fetch(TOKEN_API, {
    method: 'POST',
    headers,
    body: JSON.stringify(sendData),
  })

  if (isRefreshTokenFlow) {
    logRefreshTokenStep('upstream_response_received', {
      status: tokenResponse.status,
      ok: tokenResponse.ok,
    })
  }

  if (!tokenResponse.ok) {
    throw new Error('获取 token 失败')
  }

  const tokenData = await tokenResponse.json()

  if (isRefreshTokenFlow) {
    logRefreshTokenStep('upstream_payload_parsed', {
      has_ciphertext: Boolean(tokenData?.data?.ciphertext),
      has_iv: Boolean(tokenData?.data?.iv),
    })
  }

  const plainData = decrypt(tokenData?.data?.ciphertext, tokenData?.data?.iv, t)
  const parsedTokenData = JSON.parse(plainData)

  if (isRefreshTokenFlow) {
    logRefreshTokenStep('token_payload_ready', {
      access_token_present: Boolean(parsedTokenData?.access_token),
      refresh_token_masked: maskToken(parsedTokenData?.refresh_token),
      expires_in: parsedTokenData?.expires_in ?? null,
    })
  }

  return parsedTokenData
}

function decrypt(ciphertext, iv, t) {
  const key = generateKey(t)

  try {
    const decrypted = CryptoES.AES.decrypt(ciphertext, CryptoES.enc.Utf8.parse(key), {
      iv: CryptoES.enc.Hex.parse(iv),
      mode: CryptoES.mode.CBC,
      padding: CryptoES.pad.Pkcs7,
    })

    return CryptoES.enc.Utf8.stringify(decrypted).toString()
  } catch (error) {
    console.error('Decryption failed', error)
    throw error
  }
}

function h(charArray, modifier) {
  const uniqueChars = Array.from(new Set(charArray))
  const numericModifier = Number(String(modifier).slice(7))

  return uniqueChars
    .map((char) => {
      const charCode = char.charCodeAt(0)
      let newCharCode = Math.abs(charCode - (numericModifier % 127) - 1)

      if (newCharCode < 33) {
        newCharCode += 33
      }

      return String.fromCharCode(newCharCode)
    })
    .join('')
}

function getParams(t) {
  return {
    akv: '2.8.1496',
    apv: '1.3.6',
    b: 'XiaoMi',
    d: 'e87a4d5f4f28d7a17d73c524eaa8ac37',
    m: '23046RP50C',
    mac: '',
    n: '23046RP50C',
    t,
    wifiMac: '020000000000',
  }
}

function generateKey(t) {
  const params = getParams(t)
  const sortedKeys = Object.keys(params).sort()
  let concatenatedParams = ''

  sortedKeys.forEach((key) => {
    if (key !== 't') {
      concatenatedParams += params[key]
    }
  })

  const hashedKey = h(concatenatedParams.split(''), t)
  return CryptoES.MD5(hashedKey).toString(CryptoES.enc.Hex)
}

function renderPage(url) {
  const tokenApiUrl = `${url.origin}/api/oauth/alipan/token`

  return new Response(
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>阿里云盘 TV Token Worker</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --panel: rgba(255, 255, 255, 0.92);
        --panel-border: rgba(15, 23, 42, 0.08);
        --text: #0f172a;
        --muted: #475569;
        --soft: #64748b;
        --brand: #0f766e;
        --brand-strong: #115e59;
        --success: #047857;
        --error: #b91c1c;
        --shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
        --radius: 24px;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(14, 116, 144, 0.14), transparent 26%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
        min-height: 100vh;
      }

      a {
        color: inherit;
      }

      .page {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 40px 0 64px;
      }

      .hero {
        display: flex;
        align-items: center;
        gap: 18px;
        margin-bottom: 28px;
        padding: 28px;
        border-radius: 28px;
        border: 1px solid var(--panel-border);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .hero-icon {
        width: 64px;
        height: 64px;
        border-radius: 20px;
        background: linear-gradient(135deg, #0f766e 0%, #0ea5a4 100%);
        display: grid;
        place-items: center;
        color: #fff;
        font-size: 28px;
        flex-shrink: 0;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      .hero h1 {
        font-size: clamp(28px, 5vw, 38px);
        line-height: 1.08;
        margin-bottom: 8px;
      }

      .hero p {
        color: var(--muted);
        font-size: 15px;
      }

      .layout {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 24px;
      }

      .stack {
        display: grid;
        gap: 24px;
      }

      .card {
        border-radius: var(--radius);
        border: 1px solid var(--panel-border);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
        overflow: hidden;
      }

      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 20px 22px 0;
      }

      .card-title {
        font-size: 15px;
        font-weight: 700;
      }

      .card-body {
        padding: 18px 22px 22px;
      }

      .token-box {
        width: 100%;
        min-height: 124px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 18px;
        resize: vertical;
        background: rgba(248, 250, 252, 0.88);
        padding: 14px 16px;
        color: var(--text);
        font: 13px/1.55 Consolas, "Cascadia Code", monospace;
      }

      .token-box[rows="3"] {
        min-height: 102px;
      }

      .actions {
        display: grid;
        gap: 14px;
      }

      .button-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }

      button,
      .link-button {
        appearance: none;
        border: 0;
        border-radius: 16px;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
      }

      button:hover,
      .link-button:hover {
        transform: translateY(-1px);
      }

      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none;
      }

      .primary {
        flex: 1;
        min-width: 220px;
        padding: 16px 18px;
        color: #fff;
        font-size: 16px;
        font-weight: 700;
        background: linear-gradient(135deg, var(--brand) 0%, #0ea5a4 100%);
        box-shadow: 0 18px 32px rgba(15, 118, 110, 0.22);
      }

      .secondary,
      .ghost {
        padding: 11px 14px;
        font-size: 13px;
        font-weight: 600;
        background: rgba(148, 163, 184, 0.12);
        color: var(--text);
      }

      .ghost {
        border: 1px solid rgba(148, 163, 184, 0.24);
      }

      .status {
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(255, 255, 255, 0.76);
        color: var(--muted);
        min-height: 58px;
        display: flex;
        align-items: center;
      }

      .status.success {
        color: var(--success);
        border-color: rgba(4, 120, 87, 0.2);
        background: rgba(236, 253, 245, 0.92);
      }

      .status.error {
        color: var(--error);
        border-color: rgba(185, 28, 28, 0.2);
        background: rgba(254, 242, 242, 0.92);
      }

      .status.muted {
        color: var(--muted);
      }

      .endpoint {
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(248, 250, 252, 0.88);
        border: 1px solid rgba(148, 163, 184, 0.2);
        font: 13px/1.5 Consolas, "Cascadia Code", monospace;
        overflow-wrap: anywhere;
      }

      .hint-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
        line-height: 1.7;
      }

      .auth-link {
        display: block;
        margin-top: 14px;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px dashed rgba(15, 118, 110, 0.28);
        background: rgba(240, 253, 250, 0.9);
        color: var(--brand-strong);
        font: 13px/1.55 Consolas, "Cascadia Code", monospace;
        text-decoration: none;
        overflow-wrap: anywhere;
      }

      .tips {
        display: grid;
        gap: 14px;
      }

      .tip {
        padding: 16px 18px;
        border-radius: 18px;
        background: rgba(255, 251, 235, 0.9);
        border: 1px solid rgba(245, 158, 11, 0.2);
        color: #92400e;
      }

      .footnote {
        margin-top: 24px;
        color: var(--soft);
        font-size: 13px;
      }

      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .hero {
          align-items: flex-start;
        }
      }

      @media (max-width: 640px) {
        .page {
          width: min(100vw - 20px, 1120px);
          padding-top: 18px;
        }

        .hero,
        .card-body,
        .card-head {
          padding-left: 16px;
          padding-right: 16px;
        }

        .hero {
          padding-top: 20px;
          padding-bottom: 20px;
        }

        .button-row {
          flex-direction: column;
        }

        .primary,
        .secondary,
        .ghost {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <div class="hero-icon">云</div>
        <div>
          <h1>阿里云盘 TV Token</h1>
          <p>独立 Cloudflare Worker 版本。生成授权链接后，在新窗口中扫码登录，成功后即可拿到 access token 和 refresh token。</p>
        </div>
      </section>

      <section class="layout">
        <div class="stack">
          <article class="card">
            <div class="card-head">
              <div class="card-title">访问令牌</div>
              <button id="copy-access" class="ghost" disabled>复制</button>
            </div>
            <div class="card-body">
              <textarea id="access-token" class="token-box" rows="4" readonly placeholder="授权成功后，访问令牌会显示在这里"></textarea>
            </div>
          </article>

          <article class="card">
            <div class="card-head">
              <div class="card-title">刷新令牌</div>
              <button id="copy-refresh" class="ghost" disabled>复制</button>
            </div>
            <div class="card-body">
              <textarea id="refresh-token" class="token-box" rows="3" readonly placeholder="授权成功后，刷新令牌会显示在这里"></textarea>
            </div>
          </article>
        </div>

        <div class="stack">
          <article class="card">
            <div class="card-head">
              <div class="card-title">授权操作</div>
            </div>
            <div class="card-body actions">
              <div class="button-row">
                <button id="start-auth" class="primary" disabled>准备授权链接...</button>
                <button id="regenerate" class="secondary">重新生成链接</button>
              </div>
              <div id="status" class="status muted">正在初始化授权链接...</div>
              <a id="auth-url" class="auth-link" href="#" target="_blank" rel="noopener noreferrer">授权链接准备中...</a>
            </div>
          </article>

          <article class="card">
            <div class="card-head">
              <div class="card-title">API 路由</div>
            </div>
            <div class="card-body">
              <div class="endpoint">${escapeHtml(tokenApiUrl)}</div>
            </div>
          </article>

          <article class="card">
            <div class="card-head">
              <div class="card-title">使用说明</div>
            </div>
            <div class="card-body tips">
              <ul class="hint-list">
                <li>点击“开始授权登录”，会打开阿里云盘授权页。</li>
                <li>使用阿里云盘 App 扫码，并在手机端确认授权。</li>
                <li>授权完成后，页面会自动轮询并填充 token。</li>
                <li>如需给第三方播放器刷新 token，可直接调用上方 API。</li>
              </ul>
              <div class="tip">TV 接口通常用于第三方播放器的高速下载场景，但高速能力仍依赖阿里云盘账号本身的会员状态。</div>
            </div>
          </article>
        </div>
      </section>

      <p class="footnote">如果浏览器拦截了弹窗，可以直接点击上面的授权链接手动打开。</p>
    </main>

    <script>
      const elements = {
        accessToken: document.getElementById('access-token'),
        refreshToken: document.getElementById('refresh-token'),
        copyAccess: document.getElementById('copy-access'),
        copyRefresh: document.getElementById('copy-refresh'),
        startAuth: document.getElementById('start-auth'),
        regenerate: document.getElementById('regenerate'),
        status: document.getElementById('status'),
        authUrl: document.getElementById('auth-url'),
      }

      const state = {
        sid: '',
        authUrl: '',
        timer: null,
        authorizing: false,
      }

      function updateStatus(message, tone) {
        elements.status.textContent = message
        elements.status.className = 'status'
        if (tone) {
          elements.status.classList.add(tone)
        } else {
          elements.status.classList.add('muted')
        }
      }

      function setTokens(accessToken, refreshToken) {
        elements.accessToken.value = accessToken || ''
        elements.refreshToken.value = refreshToken || ''
        elements.copyAccess.disabled = !accessToken
        elements.copyRefresh.disabled = !refreshToken
      }

      function clearTimer() {
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = null
        }
      }

      async function requestJson(input, init) {
        const response = await fetch(input, init)
        const data = await response.json().catch(function () {
          return {}
        })

        if (!response.ok) {
          throw new Error(data.error || data.message || '请求失败')
        }

        return data
      }

      async function initAuthUrl() {
        clearTimer()
        state.authorizing = false
        elements.startAuth.disabled = true
        elements.startAuth.textContent = '准备授权链接...'
        updateStatus('正在初始化授权链接...', 'muted')

        try {
          const data = await requestJson('/api/alipan-tv-token/generate-qr', {
            method: 'POST',
          })

          if (!data.sid) {
            throw new Error('未拿到 sid')
          }

          state.sid = data.sid
          state.authUrl = '${OAUTH_AUTHORIZE_URL}?sid=' + data.sid

          elements.authUrl.href = state.authUrl
          elements.authUrl.textContent = state.authUrl
          elements.startAuth.disabled = false
          elements.startAuth.textContent = '开始授权登录'
          updateStatus('授权链接已准备好，点击按钮后在新窗口中扫码。', 'muted')
        } catch (error) {
          updateStatus(error.message || '初始化失败，请稍后再试', 'error')
          elements.authUrl.href = '#'
          elements.authUrl.textContent = '授权链接初始化失败'
          elements.startAuth.disabled = true
          elements.startAuth.textContent = '初始化失败'
        }
      }

      async function pollStatus() {
        if (!state.sid) {
          updateStatus('缺少 sid，请重新生成授权链接。', 'error')
          return
        }

        try {
          const data = await requestJson('/api/alipan-tv-token/check-status/' + encodeURIComponent(state.sid))

          if (data.status === 'LoginSuccess') {
            state.authorizing = false
            clearTimer()
            elements.startAuth.disabled = false
            elements.startAuth.textContent = '重新授权登录'
            setTokens(data.access_token, data.refresh_token)
            updateStatus('登录成功，token 已生成。', 'success')
            return
          }

          if (data.status === 'ScanSuccess') {
            updateStatus('已扫码，请在手机端确认登录。', 'muted')
          } else if (data.status === 'LoginFailed') {
            state.authorizing = false
            elements.startAuth.disabled = false
            elements.startAuth.textContent = '开始授权登录'
            updateStatus('登录失败，请重新生成链接后再试。', 'error')
            return
          } else if (data.status === 'QRCodeExpired') {
            state.authorizing = false
            elements.startAuth.disabled = false
            elements.startAuth.textContent = '开始授权登录'
            updateStatus('链接已过期，请重新生成授权链接。', 'error')
            return
          } else {
            updateStatus('等待扫码...', 'muted')
          }

          clearTimer()
          state.timer = setTimeout(pollStatus, 2000)
        } catch (error) {
          state.authorizing = false
          elements.startAuth.disabled = false
          elements.startAuth.textContent = '开始授权登录'
          updateStatus(error.message || '轮询失败，请稍后重试。', 'error')
        }
      }

      function openAuthWindow() {
        if (!state.authUrl) {
          updateStatus('授权链接还没有准备好。', 'error')
          return
        }

        clearTimer()
        state.authorizing = true
        elements.startAuth.disabled = true
        elements.startAuth.textContent = '授权中...'
        updateStatus('已打开授权页，请扫码并确认登录。', 'muted')

        const popup = window.open(state.authUrl, '_blank', 'noopener,noreferrer')
        if (!popup) {
          updateStatus('浏览器拦截了弹窗，请直接点击授权链接打开。', 'error')
        }

        state.timer = setTimeout(pollStatus, 1000)
      }

      async function copyValue(value, label) {
        if (!value) {
          return
        }

        try {
          await navigator.clipboard.writeText(value)
          updateStatus(label + ' 已复制。', 'success')
        } catch (error) {
          updateStatus('复制失败，请手动复制。', 'error')
        }
      }

      elements.startAuth.addEventListener('click', openAuthWindow)
      elements.regenerate.addEventListener('click', initAuthUrl)
      elements.copyAccess.addEventListener('click', function () {
        copyValue(elements.accessToken.value, '访问令牌')
      })
      elements.copyRefresh.addEventListener('click', function () {
        copyValue(elements.refreshToken.value, '刷新令牌')
      })
      window.addEventListener('beforeunload', clearTimer)

      setTokens('', '')
      initAuthUrl()
    </script>
  </body>
</html>`,
    {
      headers: {
        'content-type': 'text/html; charset=UTF-8',
      },
    }
  )
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }

    return map[char]
  })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json; charset=UTF-8',
    },
  })
}

function logRefreshTokenStep(step, details = {}, level = 'log') {
  const payload = JSON.stringify({
    scope: 'refresh-token',
    step,
    ...details,
  })

  if (level === 'error') {
    console.error(payload)
    return
  }

  if (level === 'warn') {
    console.warn(payload)
    return
  }

  console.log(payload)
}

function maskToken(token) {
  if (!token) {
    return ''
  }

  if (token.length <= 8) {
    return `${token.slice(0, 2)}***${token.slice(-2)}`
  }

  return `${token.slice(0, 6)}***${token.slice(-4)}`
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
