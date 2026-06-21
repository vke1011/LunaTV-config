// check_sources_queue_retry.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const MAX_DAYS = 30;
const WARN_STREAK = 3;
const ENABLE_SEARCH_TEST = true;
// 支持命令行传参: node check.js 关键词，默认 "美女"
const SEARCH_KEYWORD = process.argv[2] || "美女";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10;
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 请求头（模拟浏览器，避免被视频源拒绝） ===
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// === 中转站配置 ===
// 中转站前缀，请求时拼接在目标 URL 前面
const PROXY_PREFIX = "https://corsapi.998836.xyz/?url=";

// 需要走中转站的域名列表（在这里添加你的域名）
const PROXY_DOMAINS = ["apibdzy.com", "lovedan.net","maotaizy.com"];

// === 判断某个 URL 是否需要走中转站 ===
const needsProxy = (url) => {
  try {
    const hostname = new URL(url).hostname;
    return PROXY_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
};

// 根据是否需要中转站，返回最终请求 URL
const resolveUrl = (url) =>
  needsProxy(url) ? `${PROXY_PREFIX}${encodeURIComponent(url)}` : url;

// === 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 校验 api_site 字段
const rawSites = config.api_site;
if (!rawSites || typeof rawSites !== "object") {
  console.error("❌ 配置文件格式错误：缺少 api_site 字段");
  process.exit(1);
}

// 过滤掉缺少 name 或 api 字段的残缺条目，避免后续请求崩溃
const apiEntries = Object.values(rawSites)
  .filter((s) => {
    if (!s.name || !s.api) {
      console.warn(`⚠️  跳过残缺条目（缺少 name 或 api）:`, JSON.stringify(s));
      return false;
    }
    return true;
  })
  .map((s) => ({
    name: s.name,
    api: s.api,
    detail: s.detail || "-",
    disabled: !!s.disabled,
  }));

// === 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, "utf-8");
  const match = old.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    try {
      history = JSON.parse(match[1]);
    } catch {
      console.warn("⚠️  历史记录解析失败，将从空白开始");
    }
  }
}

// === 当前 CST 时间（用 Intl，语义化、避免手动偏移运算） ===
const now = (() => {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} CST`;
})();

// === 工具函数 ===
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// === 缓存各 API 的默认响应，避免 testSearch 重复请求 ===
const defaultResponseCache = new Map();

// === safeGet：检测 API 根路径是否可用 ===
// 成功判定：HTTP 200 + 返回对象 + code 字段符合常见约定（1 / 200 / 不存在）
// 成功时顺手写入 defaultResponseCache，供 testSearch 复用，减少一次重复请求
const safeGet = async (url) => {
  const finalUrl = resolveUrl(url);
  const viaProxy = finalUrl !== url;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(finalUrl, {
        timeout: TIMEOUT_MS,
        headers: { ...REQUEST_HEADERS, Referer: url },
      });
      const data = res.data;
      const isValidCode =
        data.code === undefined ||
        data.code === 1 ||
        data.code === 200 ||
        data.code === "1" ||
        data.code === "200";
      const isValid =
        res.status === 200 &&
        data &&
        typeof data === "object" &&
        Object.keys(data).length > 0 &&
        isValidCode;

      // 顺手缓存默认响应，testSearch 可直接复用
      if (isValid && !defaultResponseCache.has(url)) {
        defaultResponseCache.set(url, res);
      }

      return { success: isValid, viaProxy };
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
    }
  }
  // 兜底：所有重试失败
  return { success: false, viaProxy };
};

// === fetchDefault：获取 API 默认响应（带重试 + 缓存） ===
const fetchDefault = async (api) => {
  if (defaultResponseCache.has(api)) return defaultResponseCache.get(api);
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(resolveUrl(api), {
        timeout: TIMEOUT_MS,
        headers: { ...REQUEST_HEADERS, Referer: api },
      });
      defaultResponseCache.set(api, res);
      return res;
    } catch {
      if (attempt === MAX_RETRY) {
        defaultResponseCache.set(api, null);
        return null;
      }
      await delay(RETRY_DELAY_MS);
    }
  }
};

// === testSearch：测试搜索功能可用性 ===
const testSearch = async (api, keyword) => {
  const rawUrl = `${api}?wd=${encodeURIComponent(keyword)}`;
  const finalUrl = resolveUrl(rawUrl);
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const [resSearch, resDefault] = await Promise.all([
        axios.get(finalUrl, {
          timeout: TIMEOUT_MS,
          headers: { ...REQUEST_HEADERS, Referer: api },
        }),
        fetchDefault(api),
      ]);
      
      // 返回 HTML 说明触发了验证码/跳转页
      if (typeof resSearch.data === "string" && /<html/i.test(resSearch.data)) {
        return "验证码";
      }

      // 提取 msg 字段，判断服务器明确返回的禁止信息
      const msg =
        typeof resSearch.data === "string"
          ? resSearch.data
          : resSearch.data.msg ||
            resSearch.data.message ||
            resSearch.data.info ||
            resSearch.data.err ||
            resSearch.data.error ||
            "";

      if (
        resSearch.status === 403 ||
        /不支持|禁止|关闭|disabled|not support|not search|serarch/i.test(msg)
      ) {
        return "不支持";
      }

      // 仅当搜索结果和默认结果都非空时，才做对比判断是否真正执行了搜索
      // 避免两边都是空列表时误判为"不支持"
      if (resDefault) {
        const searchList = resSearch.data.data?.length
          ? resSearch.data.data
          : resSearch.data.list || [];
        const defaultList = resDefault.data?.data?.length
          ? resDefault.data.data
          : resDefault.data?.list || [];

        if (
          searchList.length > 0 &&
          defaultList.length > 0 &&
          JSON.stringify(searchList) === JSON.stringify(defaultList)
        ) {
          return "不支持";
        }
      }

      if (
        resSearch.status !== 200 ||
        !resSearch.data ||
        typeof resSearch.data !== "object"
      ) {
        return "❌";
      }

      const list =
        (resSearch.data.data?.length
          ? resSearch.data.data
          : resSearch.data.list) || [];
      if (!list.length) return "无结果";
      return list.some((item) => JSON.stringify(item).includes(keyword))
        ? "✅"
        : "不匹配";
  } catch (e) {
    if (e.response?.status === 403) return "不支持";
    console.warn(`[testSearch] ${api} 第${attempt}次失败:`, e.code || e.message, `status=${e.response?.status ?? 'N/A'}`);
    if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
  }
}
  // 兜底：所有重试失败
  return "❌";
};

// === 队列并发执行函数（修复空任务时永不 resolve 的边界 bug） ===
const queueRun = (tasks, limit) => {
  if (tasks.length === 0) return Promise.resolve([]);

  let index = 0;
  let active = 0;
  const results = [];

  return new Promise((resolve) => {
    const next = () => {
      // 提前判断：所有任务已派发且无活跃任务时结束
      if (index >= tasks.length && active === 0) return resolve(results);

      while (active < limit && index < tasks.length) {
        const i = index++;
        active++;
        tasks[i]()
          .then((res) => (results[i] = res))
          .catch((err) => (results[i] = { error: err }))
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
};

// === 主逻辑 ===
(async () => {
  console.log(
    "⏳ 正在检测 API 与搜索功能可用性（队列并发 + 重试机制 + 中转站支持）..."
  );

  if (PROXY_DOMAINS.length > 0) {
    console.log(
      `🔄 中转站已启用，共 ${PROXY_DOMAINS.length} 个域名走代理：${PROXY_DOMAINS.join(", ")}`
    );
  } else {
    console.log("ℹ️  未配置中转站域名，所有请求直连");
  }

  let completed = 0;
  const totalCount = apiEntries.length;

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    let result;
    if (disabled) {
      result = {
        name,
        api,
        disabled,
        success: null,
        viaProxy: false,
        searchStatus: "已禁用",
      };
    } else {
      const { success, viaProxy } = await safeGet(api);
      const searchStatus = ENABLE_SEARCH_TEST
        ? await testSearch(api, SEARCH_KEYWORD)
        : "-";
      result = { name, api, disabled, success, viaProxy, searchStatus };
    }

    completed++;
    const icon = result.disabled ? "🚫" : result.success ? "✅" : "❌";
    console.log(`[${completed}/${totalCount}] ${icon} ${name}`);
    return result;
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);

  const todayRecord = {
    date: new Date().toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORD,
    results: todayResults,
  };

  history.push(todayRecord);
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 ===
  const stats = {};

  // 取 push 今天之前的历史，用于判断是否为新源
  const pastHistory = history.slice(0, -1);

  for (const { name, api, detail, disabled } of apiEntries) {
    stats[api] = {
      name,
      api,
      detail,
      disabled,
      ok: 0,
      fail: 0,
      fail_streak: 0,
      trend: "",
      // 直接从 todayResults 读取，统一数据来源
      searchStatus:
        todayResults.find((x) => x.api === api)?.searchStatus ?? "-",
      status: "❌",
      viaProxy: false,
    };

    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec || rec.disabled) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
    }

    // 计算连续失败天数并写入 stats
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find((x) => x.api === api);
      if (!rec || rec.disabled) continue;
      if (rec.success) break;
      streak++;
    }
    stats[api].fail_streak = streak;

    const recordCount = stats[api].ok + stats[api].fail;
    stats[api].successRate =
      recordCount > 0
        ? ((stats[api].ok / recordCount) * 100).toFixed(1) + "%"
        : "-";

    // 最近 7 天趋势
    // 判断新源时只看今天之前的历史，避免 push 后 isNew 永远为 false
    const isNew =
      pastHistory.length > 0 &&
      pastHistory.every((day) => !day.results.find((x) => x.api === api));

    if (isNew) {
      stats[api].trend = "🆕";
    } else {
      const recent = history.slice(-7);
      stats[api].trend = recent
        .map((day) => {
          const r = day.results.find((x) => x.api === api);
          return r ? (r.disabled ? "🚫" : r.success ? "✅" : "❌") : "-";
        })
        .join("");
    }

    const latest = todayResults.find((x) => x.api === api);
    if (latest) {
      stats[api].viaProxy = latest.viaProxy || false;
    }

    if (disabled) stats[api].status = "🚫";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${totalCount} | **检测关键词:** ${SEARCH_KEYWORD}`;

  if (PROXY_DOMAINS.length > 0) {
    md += ` | **中转站:** \`${PROXY_PREFIX}\` (${PROXY_DOMAINS.length} 个域名)\n\n`;
  } else {
    md += `\n\n`;
  }

  md +=
    "| 状态 | 资源名称 | 地址 | API | 连接 | 搜索 | 成功 | 失败 | 成功率 | 最近7天趋势 |\n";
  md +=
    "|------|---------|-----|-----|:----:|---------|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    // 使用更严谨的 URL 判断，避免非 http(s) 开头的字符串被误渲染为链接
    const detailLink = /^https?:\/\//.test(s.detail)
      ? `[Link](${s.detail})`
      : s.detail;
    const apiLink = `[Link](${s.api})`;
    const proxyBadge = s.viaProxy ? "🔄" : "🌐";
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${proxyBadge} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;

  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log("📄 报告已生成:", REPORT_PATH);
})();
