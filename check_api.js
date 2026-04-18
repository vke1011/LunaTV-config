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
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10;
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 中转站配置 ===
// 中转站前缀，请求时拼接在目标 URL 前面
const PROXY_PREFIX = "https://corsapi.998836.xyz/?url=";

// 需要走中转站的域名列表（在这里添加你的域名）
// 示例：
// const PROXY_DOMAINS = [
//   "example1.com",
//   "api.example2.net",
// ];
const PROXY_DOMAINS = [
  "apibdzy.com",
  "lovedan.net",
];

// === 判断某个 URL 是否需要走中转站 ===
const needsProxy = (url) => {
  try {
    const hostname = new URL(url).hostname;
    return PROXY_DOMAINS.some((domain) => hostname === domain || hostname.endsWith("." + domain));
  } catch {
    return false;
  }
};

// 根据是否需要中转站，返回最终请求 URL
const resolveUrl = (url) => (needsProxy(url) ? `${PROXY_PREFIX}${encodeURIComponent(url)}` : url);

// === 加载配置 ===
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const apiEntries = Object.values(config.api_site).map((s) => ({
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
    } catch {}
  }
}

// === 当前 CST 时间 ===
const now =
  new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16) + " CST";

// === 工具函数（带重试 + 中转站支持） ===
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const safeGet = async (url) => {
  const finalUrl = resolveUrl(url);
  const viaProxy = finalUrl !== url;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(finalUrl, { timeout: TIMEOUT_MS });
      return { success: res.status === 200, viaProxy };
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return { success: false, viaProxy };
    }
  }
};

const testSearch = async (api, keyword) => {
  const rawUrl = `${api}?wd=${encodeURIComponent(keyword)}`;
  const finalUrl = resolveUrl(rawUrl);
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(finalUrl, { timeout: TIMEOUT_MS });
      if (res.status !== 200 || !res.data || typeof res.data !== "object") return "❌";
      const list = res.data.list || [];
      if (!list.length) return "无结果";
      return list.some((item) => JSON.stringify(item).includes(keyword)) ? "✅" : "不匹配";
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return "❌";
    }
  }
};

// === 队列并发执行函数 ===
const queueRun = (tasks, limit) => {
  let index = 0;
  let active = 0;
  const results = [];

  return new Promise((resolve) => {
    const next = () => {
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
      if (index >= tasks.length && active === 0) resolve(results);
    };
    next();
  });
};

// === 主逻辑 ===
(async () => {
  console.log("⏳ 正在检测 API 与搜索功能可用性（队列并发 + 重试机制 + 中转站支持）...");

  if (PROXY_DOMAINS.length > 0) {
    console.log(`🔀 中转站已启用，共 ${PROXY_DOMAINS.length} 个域名走代理：${PROXY_DOMAINS.join(", ")}`);
  } else {
    console.log("ℹ️  未配置中转站域名，所有请求直连");
  }

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    if (disabled) {
      return { name, api, disabled, success: false, viaProxy: false, searchStatus: "无法搜索" };
    }

    const { success, viaProxy } = await safeGet(api);
    const searchStatus = ENABLE_SEARCH_TEST ? await testSearch(api, SEARCH_KEYWORD) : "-";
    return { name, api, disabled, success, viaProxy, searchStatus };
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
      searchStatus: "-",
      status: "❌",
      viaProxy: false,
    };

    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
    }

    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) break;
      streak++;
    }

    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";

    const recent = history.slice(-7);
    stats[api].trend = recent
      .map((day) => {
        const r = day.results.find((x) => x.api === api);
        return r ? (r.success ? "✅" : "❌") : "-";
      })
      .join("");

    const latest = todayResults.find((x) => x.api === api);
    if (latest) {
      stats[api].searchStatus = latest.searchStatus;
      stats[api].viaProxy = latest.viaProxy || false;
    }

    if (disabled) stats[api].status = "🚫";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${apiEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}`;

  if (PROXY_DOMAINS.length > 0) {
    md += ` | **中转站:** \`${PROXY_PREFIX}\` (${PROXY_DOMAINS.length} 个域名)\n\n`;
  } else {
    md += `\n\n`;
  }

  md += "| 状态 | 资源名称 | 地址 | API | 中转 | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 |\n";
  md += "|------|---------|-----|-----|:----:|---------|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    const detailLink = s.detail.startsWith("http") ? `[Link](${s.detail})` : s.detail;
    const apiLink = `[Link](${s.api})`;
    const proxyBadge = s.viaProxy ? "🔀" : "🌐";
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${proxyBadge} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;

  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log("📄 报告已生成:", REPORT_PATH);
})();
