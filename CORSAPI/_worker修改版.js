// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }

    return handleRequest(request)
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/vke1011/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/vke1011/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/vke1011/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// 🔑 从 URL 中提取唯一标识符（用于生成唯一路径）
function extractSourceId(apiUrl) {
  try {
    const url = new URL(apiUrl)
    const hostname = url.hostname

    // 提取主域名作为标识符（去掉子域名和 TLD）
    // 例如：caiji.maotaizy.cc → maotai
    //       iqiyizyapi.com → iqiyi
    //       api.maoyanapi.top → maoyan
    const parts = hostname.split('.')

    // 如果是 caiji.xxx.com 或 api.xxx.com 格式，取倒数第二部分
    if (parts.length >= 3 && (parts[0] === 'caiji' || parts[0] === 'api' || parts[0] === 'cj' || parts[0] === 'www')) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '')
    }

    // 否则取第一部分（去掉 zyapi/zy 等后缀）
    let name = parts[0].toLowerCase()
    name = name.replace(/zyapi$/, '').replace(/zy$/, '').replace(/api$/, '')
    return name.replace(/[^a-z0-9]/g, '') || 'source'
  } catch {
    // URL 解析失败，使用随机标识
    return 'source' + Math.random().toString(36).substr(2, 6)
  }
}

// JSON api 字段前缀替换（改进版：为每个源生成唯一路径）
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]

      // 去掉旧的代理前缀（如果有）
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)

      // 🔑 关键修改：为每个源生成唯一的路径
      if (!apiUrl.startsWith(newPrefix)) {
        const sourceId = extractSourceId(apiUrl)

        // 从 newPrefix 中提取 origin 和基础路径
        // 例如：https://xx.fn0.qzz.io/?url= → https://xx.fn0.qzz.io/p/iqiyi?url=
        const baseUrl = newPrefix.replace(/\/?\?url=$/, '') // 去掉结尾的 /?url= 或 ?url=
        apiUrl = `${baseUrl}/p/${sourceId}?url=${apiUrl}`
      }

      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ---------- 安全版：KV 缓存 ----------
async function getCachedJSON(url) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'

  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await KV.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })   // 缓存三十分钟
    return data
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    return await res.json()
  }
}

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request) {
  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 🔑 新增：处理源专属路径 /p/{sourceId}?url=...
  // 这样可以让 TVBox 认为每个源是不同的域名/路径
  if (pathname.startsWith('/p/') && targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // 通用代理请求处理（兼容旧的 /?url=... 格式）
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix)
  }

  // 返回首页文档
  return handleHomePage(currentOrigin, defaultPrefix)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 🚨 防止递归调用自身
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 🚨 防止无效 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  // 🔑 修复：只提取 url= 参数的值，不要包含后续的 & 参数
  const urlMatch = request.url.match(/[?&]url=([^&]+)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  // 🔑 关键修复：提取并传递额外的 query 参数（如 ac=list, ac=detail 等）
  const reqUrl = new URL(request.url)
  const extraParams = new URLSearchParams()

  // 遍历所有 query 参数，把除了 url 之外的参数都加到目标 URL
  for (const [key, value] of reqUrl.searchParams) {
    if (key !== 'url') {
      extraParams.append(key, value)
    }
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)

    // 🔑 将额外参数追加到目标 URL
    for (const [key, value] of extraParams) {
      targetURL.searchParams.append(key, value)
    }
  } catch {
    await logError('proxy', { message: 'Invalid URL', url: fullTargetUrl })
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    await logError('proxy', { message: err.message || '代理请求失败', url: fullTargetUrl })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// ---------- JSON 格式输出处理子模块 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource)

    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

// ---------- 首页文档处理（深色主题 + 绿色高亮） ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CORSAPI - API 中转代理服务</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='80' font-size='80'%3E🔄%3C/text%3E%3C/svg%3E">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --luna-green: #22C55E;
      --luna-green-deep: #10B981;
      --bg: #0F1117;
      --card: #1F2937;
      --border: #374151;
      --text: #FFFFFF;
      --sub: #9ca3af;
      --muted: #6b7280;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
      padding: 24px 16px;
    }
    .container {
      max-width: 880px;
      margin: 0 auto;
    }
    /* 头部 */
    .hero {
      padding: 32px 28px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .hero h1 {
      font-size: 28px;
      font-weight: 800;
      margin-bottom: 8px;
      color: var(--text);
    }
    .hero p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 16px;
    }
    /* 章节 */
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 14px;
    }
    .section-title::before {
      content: "";
      width: 3px;
      height: 14px;
      background: linear-gradient(180deg, var(--luna-green), var(--luna-green-deep));
      border-radius: 2px;
    }
    .section p {
      color: var(--sub);
      font-size: 14px;
      margin-bottom: 10px;
    }
    .section p:last-child {
      margin-bottom: 0;
    }
    pre {
      background: #0b0e14;
      color: #d1d5db;
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      margin: 10px 0;
      white-space: pre;
    }
    pre .g { color: var(--luna-green); }
    code {
      background: rgba(34, 197, 94, 0.12);
      color: var(--luna-green);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Consolas, Monaco, monospace;
      font-size: 12.5px;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 8px 0;
    }
    li {
      color: var(--sub);
      font-size: 14px;
      padding: 6px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    li::before {
      content: "";
      width: 5px;
      height: 5px;
      background: var(--luna-green);
      border-radius: 50%;
      flex-shrink: 0;
    }
    /* 示例 / 表格（专属class） */
    .example {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin: 12px 0;
    }
    .config-table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      color: var(--sub);
    }
    .config-table td {
      padding: 6px 8px;
      vertical-align: middle;
      border-bottom: 1px solid var(--border);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      background: var(--luna-green);
      color: #052e16;
      border-radius: 12px;
      font-size: 0.85em;
      margin-left: 6px;
    }
    .copy-btn {
      background: var(--luna-green);
      color: #052e16;
      border: none;
      border-radius: 4px;
      padding: 2px 8px;
      margin-left: 6px;
      font-size: 0.85em;
      cursor: pointer;
    }
    .copy-btn:hover {
      background: var(--luna-green-deep);
    }
    .status {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: var(--luna-green);
      border-radius: 50%;
      margin-right: 6px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .footer {
      text-align: center;
      padding: 20px 0 4px 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .footer a {
      color: var(--luna-green);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 600px) {
      body { padding: 16px 12px; }
      .hero { padding: 22px 18px; }
      .hero h1 { font-size: 22px; }
      .section { padding: 16px 18px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 头部 -->
    <div class="hero">
      <h1>🔄 CORSAPI / LunaTV</h1>
      <p><span class="status"></span>API 中转代理服务正在运行</p>
      <p>基于 Cloudflare Workers 的通用 API 中转代理服务，用于加速和转发 API 请求。</p>
    </div>

    <!-- 示例 -->
    <div class="section">
      <div class="section-title">📖 基本用法</div>
      <p>在 API 请求前添加代理地址和 + <code>?url=</code>参数：</p>
      <pre><span class="g">${defaultPrefix}https://api.example.com/endpoint</span></pre>
      <p>示例：代理一个 API 请求</p>
      <pre>原始请求: <span class="g">https://api.example.com/data?id=123</span>
通过代理: <span class="g">${currentOrigin}/?url=https://api.example.com/data&id=123</span></pre>
    </div>

    <div class="section">
      <div class="section-title">🚀 高级用法</div>
      <p>使用专属路径避免缓存冲突（推荐）：</p>
      <pre><span class="g">${currentOrigin}/p/source1?url=https://api1.example.com/endpoint</span></pre>
      <p>为不同 API 源使用不同路径标识符（如 <code class="g">/p/source1</code>、<code class="g">/p/source2</code>），可以：</p>
      <ul>
        <li>避免不同源之间的缓存冲突</li>
        <li>提高客户端兼容性</li>
        <li>更好的请求管理</li>
      </ul>
    </div>

    <div class="section">
      <div class="section-title">🔧 参数转发</div>
      <p>所有额外的 query 参数都会自动转发到目标 API：</p>
      <p>参数自动转发示例</p>
      <pre>请求：<span class="g">${currentOrigin}/?url=https://api.example.com/list&page=1&limit=10</span>
转发：<span class="g">https://api.example.com/list?page=1&limit=10</span></pre>
    </div>

    <div class="section">
      <div class="section-title">⚙️ 配置订阅参数说明</div>
      <div class="example">
        <table class="config-table">
          <tr>
            <td><code>format</code></td>
            <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
                <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
                <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
                <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
          </tr>
          <tr>
            <td><code>source</code></td>
            <td><code>jin18</code> = 精简版<br>
                <code>jingjian</code> = 精简版+成人<br>
                <code>full</code> = 完整版（默认）</td>
          </tr>
          <tr>
            <td><code>prefix</code></td>
            <td>自定义代理前缀（仅在 <code>format=1</code> 或 <code>3</code> 时生效）</td>
          </tr>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">📦 配置订阅链接示例</div>

      <p>精简版（jin18）</p>
      <pre>原始 JSON：
<span class="g copyable">${currentOrigin}/?format=0&source=jin18</span> <button class="copy-btn" data-url="${currentOrigin}/?format=0&source=jin18">复制</button><br>
中转 JSON：
<span class="g copyable">${currentOrigin}/?format=1&source=jin18</span> <button class="copy-btn" data-url="${currentOrigin}/?format=1&source=jin18">复制</button><br>
原始 Base58：
<span class="g copyable">${currentOrigin}/?format=2&source=jin18</span> <button class="copy-btn" data-url="${currentOrigin}/?format=2&source=jin18">复制</button><br>
中转 Base58：
<span class="g copyable">${currentOrigin}/?format=3&source=jin18</span> <button class="copy-btn" data-url="${currentOrigin}/?format=3&source=jin18">复制</button></pre>

      <p>精简版+成人（jingjian）</p>
      <pre>原始 JSON：
<span class="g copyable">${currentOrigin}/?format=0&source=jingjian</span> <button class="copy-btn" data-url="${currentOrigin}/?format=0&source=jingjian">复制</button><br>
中转 JSON：
<span class="g copyable">${currentOrigin}/?format=1&source=jingjian</span> <button class="copy-btn" data-url="${currentOrigin}/?format=1&source=jingjian">复制</button><br>
原始 Base58：
<span class="g copyable">${currentOrigin}/?format=2&source=jingjian</span> <button class="copy-btn" data-url="${currentOrigin}/?format=2&source=jingjian">复制</button><br>
中转 Base58：
<span class="g copyable">${currentOrigin}/?format=3&source=jingjian</span> <button class="copy-btn" data-url="${currentOrigin}/?format=3&source=jingjian">复制</button></pre>

      <p>完整版（full，默认）</p>
      <pre>原始 JSON：
<span class="g copyable">${currentOrigin}/?format=0&source=full</span> <button class="copy-btn" data-url="${currentOrigin}/?format=0&source=full">复制</button><br>
中转 JSON：
<span class="g copyable">${currentOrigin}/?format=1&source=full</span> <button class="copy-btn" data-url="${currentOrigin}/?format=1&source=full">复制</button><br>
原始 Base58：
<span class="g copyable">${currentOrigin}/?format=2&source=full</span> <button class="copy-btn" data-url="${currentOrigin}/?format=2&source=full">复制</button><br>
中转 Base58：
<span class="g copyable">${currentOrigin}/?format=3&source=full</span> <button class="copy-btn" data-url="${currentOrigin}/?format=3&source=full">复制</button></pre>
    </div>

    <div class="section">
      <div class="section-title">✨ 功能特性</div>
      <ul>
        <li>✅ 支持所有 HTTP 方法（GET、POST、PUT、DELETE 等）</li>
        <li>✅ 自动转发请求头和请求体</li>
        <li>✅ 完整的 CORS 支持</li>
        <li>✅ 超时保护<span class="badge">9秒</span></li>
        <li>✅ 自动参数转发</li>
        <li>✅ 防止递归调用</li>
        <li>✅ 可选的 KV 缓存支持</li>
        <li>✅ JSON 配置订阅（多源切换：精简 / 增强 / 完整）</li>
        <li>✅ 多格式输出（原始 / 代理前缀 / Base58 / 组合）</li>
        <li>✅ 自定义代理前缀</li>
        <li>✅ 源专属路径（避免缓存冲突，兼容 TVBox 多源切换）</li>
        <li>✅ 健康检查端点（/health）</li>
      </ul>
    </div>

    <div class="section">
      <div class="section-title">🏥 健康检查</div>
      <p>访问 <code>/health</code> 端点检查服务状态：</p>
      <pre><span class="g copyable">${currentOrigin}/health</span> <button class="copy-btn" data-url="${currentOrigin}/health">复制</button></pre>
    </div>

    <div class="footer">
      <p>
        项目地址：<a href="https://github.com/vke1011/CORSAPI" target="_blank">vke1011/CORSAPI</a><br>
        <small>基于 <a href="https://github.com/SzeMeng76/CORSAPI" target="_blank">SzeMeng76/CORSAPI</a> 二次开发</small>
      </p>
      <p>Powered by Cloudflare Workers</p>
    </div>
  </div>

  <script>
    document.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.addEventListener('click', function() {
        const url = this.dataset.url;
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            this.innerText = '已复制！';
            setTimeout(() => (this.innerText = '复制'), 1500);
          });
        }
      });
    });
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
