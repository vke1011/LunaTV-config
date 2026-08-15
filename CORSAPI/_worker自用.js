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
    // 例如：caiji.maotaizy.cc → maotaizy
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

  // 通用代理请求处理（兼容 /?url=... 和 /p/xxx?url=... 两种格式）
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

// ---------- 首页文档处理 ----------
async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>通用 API 中转代理，用于访问被墙或限制的接口。</p>
  
  <h2>使用方法</h2>
  <p>中转任意 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>
  <h2>高级用法</h2>
  <p>为不同 API 源使用不同路径标识符：如<code>/p/source1?url=目标地址</code> 参数</p>
  <pre>${currentOrigin}/p/source1?url=<示例API地址></pre>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
  <p>订阅中转采用高级用法</p>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 支持 GET、POST、PUT、DELETE 等所有 HTTP 方法</li>
    <li>✅ 自动转发请求头和请求体</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ 超时保护（9 秒）</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
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
