//  update_readme.js
const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, 'report.md');
const readmePath = path.join(__dirname, 'README.md');

// 读取 report.md
if (!fs.existsSync(reportPath)) {
    console.error('❌ report.md 不存在，请先运行 check_api.js');
    process.exit(1);
}

const reportContent = fs.readFileSync(reportPath, 'utf-8');

// 提取 Markdown 表格
const tableMatch = reportContent.match(/\| 状态 \|[\s\S]+?\n\n/);
if (!tableMatch) {
    console.error('❌ report.md 中未找到表格');
    process.exit(1);
}
let tableMd = tableMatch[0].trim();

// 拆分表格行
const lines = tableMd.split('\n');
const header = lines.slice(0, 2); // 表头部分
const rows = lines.slice(2); // 数据部分

// 解析每一行数据，提取可用率
const rowsWithData = rows.map(line => {
    const cols = line.split('|').map(c => c.trim());
    const status = cols[1]; // 状态列
    const apiName = cols[2]; // API名称列
    const apiAddress = cols[4]; // API地址列
    const successCount = parseInt(cols[7]) || 0; // 成功次数
    const failCount = parseInt(cols[8]) || 0; // 失败次数
    const availabilityStr = cols[9]; // 可用率列
    const consecutiveFailDays = parseInt(cols[9]) || 0; // 连续失败天数

    // 提取可用率数字（去掉%符号）
    const availabilityMatch = availabilityStr.match(/(\d+\.?\d*)%/);
    const availability = availabilityMatch ? parseFloat(availabilityMatch[1]) : 0;

    return {
        line: line,
        cols: cols,
        status: status,
        apiName: apiName,
        apiAddress: apiAddress,
        successCount: successCount,
        failCount: failCount,
        availability: availability,
        consecutiveFailDays: consecutiveFailDays,
        isSuccess: status.includes('✅')
    };
});

// 按照可用率排序（从高到低），可用率相同时按API名称排序
rowsWithData.sort((a, b) => {
    if (Math.abs(b.availability - a.availability) > 0.01) { // 避免浮点数精度问题
        return b.availability - a.availability; // 按可用率降序
    }
    return a.apiName.localeCompare(b.apiName); // 可用率相同时按API名称升序
});

// 生成排序后的表格行
const sortedRows = rowsWithData.map(row => row.line);

// 更新表格
tableMd = [...header, ...sortedRows].join('\n');

// 统计数据
const totalApis = rowsWithData.length;
const successApis = rowsWithData.filter(row => row.isSuccess).length;
const failApis = totalApis - successApis;

// 按可用率区间分类
const perfectApis = rowsWithData.filter(row => row.availability === 100 && !row.status.includes('🚫')).length;
const highAvailability = rowsWithData.filter(row => row.availability >= 80 && row.availability < 100 && !row.status.includes('🚫')).length;
const mediumAvailability = rowsWithData.filter(row => row.availability >= 50 && row.availability < 80 && !row.status.includes('🚫')).length;
const lowAvailability = rowsWithData.filter(row => row.availability < 50 && !row.status.includes('🚫')).length;

// 计算平均可用率
const activeRows = rowsWithData.filter(row => !row.status.includes('🚫'));
const averageAvailability = activeRows.length > 0 
  ? (activeRows.reduce((sum, row) => sum + row.availability, 0) / activeRows.length).toFixed(1) 
  : 0;

// 获取当前 CST 时间
const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16) + " CST";

// 生成带统计和时间戳的区块
const tableBlock =
    `## API 状态（最近更新：${now}）\n\n` +
    `- 总 API 数量：${totalApis}\n` +
    `- 成功 API 数量：${successApis}\n` +
    `- 失败 API 数量：${failApis}\n` +
    `- 平均可用率：${averageAvailability}%\n` +
    `- 完美可用率（100%）：${perfectApis} 个\n` +
    `- 高可用率（80%-99%）：${highAvailability} 个\n` +
    `- 中等可用率（50%-79%）：${mediumAvailability} 个\n` +
    `- 低可用率（<50%）：${lowAvailability} 个\n\n` +
    `<div style="font-size: 11px;">\n\n` +
    `<!-- API_TABLE_START -->\n${tableMd}\n<!-- API_TABLE_END -->`;

// 读取 README.md（可能不存在）
let readmeContent = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : "";

// 替换或追加
if (readmeContent.includes("<!-- API_TABLE_START -->") && readmeContent.includes("<!-- API_TABLE_END -->")) {
    readmeContent = readmeContent.replace(
        /## API 状态（最近更新：[^\n]+）[\s\S]*?<!-- API_TABLE_END -->/,
        tableBlock
    );
    console.log("✅ README.md 已更新 API 状态表格（按可用率排序）");
} else {
    readmeContent += `\n\n${tableBlock}\n`;
    console.log("⚠️ README.md 未找到标记，已自动追加 API 状态表格到末尾");
}

// 写回文件
fs.writeFileSync(readmePath, readmeContent, 'utf-8');

// 输出排序结果摘要
console.log(`\n📊 统计摘要：`);
console.log(`- 平均可用率：${averageAvailability}%`);
console.log(`- 完美可用率 API：${perfectApis} 个`);
console.log(`- 高可用率 API：${highAvailability} 个`);
console.log(`- 中等可用率 API：${mediumAvailability} 个`);
console.log(`- 低可用率 API：${lowAvailability} 个`);

// 显示排序后的前10个和后5个API
console.log(`\n🏆 可用率最高的前10个API：`);
rowsWithData.slice(0, 10).forEach((row, index) => {
    console.log(`${index + 1}. ${row.apiName}: ${row.availability}%`);
});

console.log(`\n⚠️ 可用率最低的后5个API：`);
rowsWithData.slice(-5).forEach((row, index) => {
    console.log(`${rowsWithData.length - 4 + index}. ${row.apiName}: ${row.availability}%`);
});
