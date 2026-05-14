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

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const PROXY_PREFIX = "https://corsapi.998836.xyz/?url=";
const PROXY_DOMAINS = ["apibdzy.com", "lovedan.net"];

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

const resolveUrl = (url) =>
  needsProxy(url) ? `${PROXY_PREFIX}${encodeURIComponent(url)}` : url;

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

const rawSites = config.api_site;
if (!rawSites || typeof rawSites !== "object") {
  console.error("❌ 配置文件格式错误：缺少 api_site 字段");
  process.exit(1);
}

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const defaultResponseCache = new Map();

// === [改动1] safeGet：增加 XSS 污染检测，返回新增的 xssFlag 字段 ===
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

      // 检测响应数据是否含有注入的 <script 标签
      const rawJson = JSON.stringify(data);
      const xssFlag = /<script/i.test(rawJson);

      const isValid =
        res.status === 200 &&
        data &&
        typeof data === "object" &&
        Object.keys(data).length > 0 &&
        isValidCode;
      // 注意：xssFlag 不影响 isValid，数据可用性和污染状态分开判断
      // 这样报告里能同时看到"连接正常"和"数据有污染"两个信息

      if (isValid && !defaultResponseCache.has(url)) {
        defaultResponseCache.set(url, res);
      }

      return { success: isValid, viaProxy, xssFlag };
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
    }
  }
  return { success: false, viaProxy, xssFlag: false };
};

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

      if (typeof resSearch.data === "string" && /<html/i.test(resSearch.data)) {
        return "验证码";
      }

      const msg =
        typeof resSearch.data === "string"
          ? resSearch.data
          : resSearch.data.msg ||
            resSearch.data.message ||
            resSearch.data.info ||
            "";

      if (
        resSearch.status === 403 ||
        /不支持|禁止|关闭|disabled|not support/i.test(msg)
      ) {
        return "不支持";
      }

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
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
    }
  }
  return "❌";
};

const queueRun = (tasks, limit) => {
  if (tasks.length === 0) return Promise.resolve([]);

  let index = 0;
  let active = 0;
  const results = [];

  return new Promise((resolve) => {
    const next = () => {
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
        xssFlag: false,
        searchStatus: "已禁用",
      };
    } else {
      // === [改动2] 解构时取出 xssFlag ===
      const { success, viaProxy, xssFlag } = await safeGet(api);
      const searchStatus = ENABLE_SEARCH_TEST
        ? await testSearch(api, SEARCH_KEYWORD)
        : "-";
      result = { name, api, disabled, success, viaProxy, xssFlag, searchStatus };
    }

    completed++;
    // === [改动3] 控制台输出增加污染提示 ===
    const icon = result.disabled ? "🚫" : result.success ? "✅" : "❌";
    const xssHint = result.xssFlag ? " ⚠️ 数据污染" : "";
    console.log(`[${completed}/${totalCount}] ${icon} ${name}${xssHint}`);
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

  const stats = {};
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
      searchStatus:
        todayResults.find((x) => x.api === api)?.searchStatus ?? "-",
      // === [改动4] stats 里记录 xssFlag，供报告使用 ===
      xssFlag: todayResults.find((x) => x.api === api)?.xssFlag ?? false,
      status: "❌",
      viaProxy: false,
    };

    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec || rec.disabled) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
    }

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

  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${totalCount} | **检测关键词:** ${SEARCH_KEYWORD}`;

  if (PROXY_DOMAINS.length > 0) {
    md += ` | **中转站:** \`${PROXY_PREFIX}\` (${PROXY_DOMAINS.length} 个域名)\n\n`;
  } else {
    md += `\n\n`;
  }

  // === [改动4续] 表头增加"污染"列 ===
  md +=
    "| 状态 | 资源名称 | 地址 | API | 连接 | 搜索 | 污染 | 成功 | 失败 | 成功率 | 最近7天趋势 |\n";
  md +=
    "|------|---------|-----|-----|:----:|---------|:----:|---------:|--------:|-------:|--------------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    const detailLink = /^https?:\/\//.test(s.detail)
      ? `[Link](${s.detail})`
      : s.detail;
    const apiLink = `[Link](${s.api})`;
    const proxyBadge = s.viaProxy ? "🔄" : "🌐";
    const xssBadge = s.xssFlag ? "⚠️" : "-";
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${proxyBadge} | ${s.searchStatus} | ${xssBadge} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;

  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  console.log("📄 报告已生成:", REPORT_PATH);
})();
