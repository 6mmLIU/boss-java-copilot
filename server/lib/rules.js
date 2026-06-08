import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "./defaults.js";

const obfuscatedDigits = {
  "\ue031": "0",
  "\ue032": "1",
  "\ue033": "2",
  "\ue034": "3",
  "\ue035": "4",
  "\ue036": "5",
  "\ue037": "6",
  "\ue038": "7",
  "\ue039": "8",
  "\ue03a": "9",
};

const strongCompanySignals = [
  "阿里",
  "阿里巴巴",
  "淘宝",
  "天猫",
  "蚂蚁",
  "腾讯",
  "京东",
  "百度",
  "美团",
  "字节",
  "抖音",
  "快手",
  "小米",
  "网易",
  "滴滴",
  "携程",
  "华为",
  "中兴",
  "联想",
  "海康",
  "大华",
  "科大讯飞",
  "同花顺",
  "恒生",
  "东方财富",
  "银联",
  "招银",
  "浦银",
  "平安",
  "兴业",
  "中信",
  "华泰",
  "招商",
  "蔚来",
  "理想",
  "小鹏",
  "比亚迪",
  "特斯拉",
  "宁德",
  "得物",
  "小红书",
];

const qualityOrgSignals = [
  "上市",
  "集团",
  "控股",
  "股份",
  "国企",
  "央企",
  "总部",
  "大型",
  "知名",
  "独角兽",
  "B轮",
  "C轮",
  "D轮",
];

export function normalizeText(text = "") {
  return [...String(text)]
    .map((char) => obfuscatedDigits[char] ?? char)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasAny(text = "", words = []) {
  const haystack = normalizeText(text).toLowerCase();
  return words.some((word) => haystack.includes(String(word).toLowerCase()));
}

export function findHits(text = "", words = [], limit = 6) {
  const haystack = normalizeText(text).toLowerCase();
  return words
    .filter((word) => haystack.includes(String(word).toLowerCase()))
    .slice(0, limit);
}

export function parseSalary(text = "") {
  const salary = normalizeText(text);
  if (!salary || /面议|薪资面议/.test(salary)) {
    return { raw: salary, min: null, max: null };
  }
  const range = salary.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  if (range) {
    return { raw: salary, min: Number(range[1]), max: Number(range[2]) };
  }
  const single = salary.match(/(\d+(?:\.\d+)?)\s*K/i);
  if (single) {
    const value = Number(single[1]);
    return { raw: salary, min: value, max: value };
  }
  return { raw: salary, min: null, max: null };
}

function detectExperience(text = "") {
  const source = normalizeText(text);
  if (/5\s*-\s*10年|5-10年|五年以上|5年以上|6年以上|7年以上|8年以上/.test(source)) return "5-10年";
  if (/10年以上|十年以上|(^|[^-\d])10年/.test(source)) return "10年以上";
  if (/3\s*-\s*5年|3-5年/.test(source)) return "3-5年";
  if (/1\s*-\s*3年|1-3年|2年以上|三年以下/.test(source)) return "1-3年";
  if (/1年以内|一年以内/.test(source)) return "1年以内";
  if (/经验不限|不限经验|无经验|零经验/.test(source)) return "经验不限";
  if (/应届|校招|26届|25届/.test(source)) return "应届";
  return "";
}

function scoreCompany(text, salaryMin, config) {
  const strong = findHits(text, strongCompanySignals, 3);
  const org = findHits(text, qualityOrgSignals, 3);
  const domain = findHits(text, config.preferredDomains, 4);
  const tech = findHits(text, config.preferredTech, 4);
  const platform = /平台|中台|交易|支付|清结算|风控|供应链|ERP|SaaS|云|数据|核心系统|基础架构|中间件/.test(text);

  if (strong.length) return { pass: true, score: 16, reason: `大厂/品牌: ${strong.join("/")}` };
  if (org.length) return { pass: true, score: 11, reason: `组织质量: ${org.join("/")}` };
  if (salaryMin >= 18) return { pass: true, score: 10, reason: "薪资带较高" };
  if (salaryMin >= 15 && domain.length) {
    return { pass: true, score: 9, reason: `业务域匹配: ${domain.join("/")}` };
  }
  if (salaryMin >= 15 && platform && tech.length >= 2) {
    return { pass: true, score: 8, reason: `平台/技术栈: ${tech.slice(0, 2).join("/")}` };
  }
  return { pass: false, score: 0, reason: "公司/业务质量未达优先模式" };
}

function blockReason(text, title, config, summaryText = text) {
  if (hasAny(text, config.hardExclusions)) return "硬性排除词";
  if (/\bOD\b|OD岗位|外包OD/i.test(text)) return "OD/外包岗位";
  if (/(\d+\s*个月|半年|短期|项目制)/i.test(text)) return "短期/项目制";
  if (/\bTL\b|team\s*lead|leader/i.test(text)) return "管理或带队岗位";
  if (/硕士及以上|硕士以上|研究生及以上|硕士学历|博士/.test(text)) return "学历要求不匹配";
  if (/导师|讲师|培训|交付|非开发岗|解决方案|售前|客户成功/.test(title)) return "非研发交付/培训类";
  if (
    /测开|测试开发|测试|算法测开|算法.*招聘|python.*java|java.*python|java.*go\b|go.*java|php.*java|java.*php|c\+\+.*java|java.*c\+\+|c#.*java|java.*c#|\.net.*java|java.*\.net|cobol.*java|java.*cobol/i.test(
      title,
    )
  ) {
    return "混合非 Java/测试方向";
  }
  if (/(ios|android|安卓|移动端)/i.test(title)) return "移动端方向";
  if (/(golang|go后端|\bgo\b|c\+\+|python|php|node\.?js|前端)/i.test(title) && !/java/i.test(title)) {
    return "非 Java 标题";
  }
  if (/测试工程师|运维工程师|实施工程师|项目经理|销售|客服/.test(text) && !/java|后端|服务端/i.test(text)) {
    return "非研发岗位";
  }
  if (hasAny(summaryText, config.outsourcingSignals)) return "外包/驻场信号";
  if (/精通.*架构|架构设计经验|架构师/.test(text)) return "偏架构/专家岗";
  return "";
}

export function detectSecurityBlocker(text = "") {
  const body = normalizeText(text);
  if (
    /安全验证|身份验证|验证身份|滑块|拖动.*验证|验证码|人机验证|请完成验证|扫码登录|扫码.*登录|微信登录|手机号登录|密码登录|登录后继续|请先登录|登录 \/ 注册|BOSS直聘 APP/.test(
      body,
    )
  ) {
    return "login/captcha/security";
  }
  if (/今日沟通已达上限|沟通次数已用完|打招呼次数已达上限/.test(body)) {
    return "daily communication limit";
  }
  return "";
}

export function screenJob(job = {}, configInput = defaultConfig) {
  const config = { ...defaultConfig, ...configInput };
  const title = normalizeText(job.title || job.titleDecoded || "");
  const company = normalizeText(job.company || job.companyDecoded || "");
  const salaryRaw = normalizeText(job.salary || job.salaryDecoded || "");
  const location = normalizeText(job.location || job.locationDecoded || "");
  const meta = normalizeText(job.meta || job.tags || "");
  const detail = normalizeText(job.detailText || job.text || job.description || "");
  const chatText = normalizeText(job.chatText || "");
  const query = normalizeText(job.query || "");
  const summaryText = normalizeText([title, company, salaryRaw, location, meta].filter(Boolean).join(" "));
  const text = normalizeText([summaryText, detail].filter(Boolean).join(" "));
  const salary = parseSalary(salaryRaw || text);
  const hardBlock = blockReason(text, title, config, summaryText);
  const security = detectSecurityBlocker([text, chatText].join(" "));
  const experience = detectExperience(text);
  const techHits = findHits(text, config.preferredTech, 6);
  const domainHits = findHits(text, config.preferredDomains, 6);
  const active = (text.match(/在线|刚刚活跃|今日活跃|3日内活跃|本周活跃/) || [])[0] || "";
  const reasons = [];
  const warnings = [];
  let score = 42;

  if (security) {
    return { pass: false, shouldApply: false, score: 0, status: "blocked", reason: security, reasons: [security], warnings };
  }
  if (/继续沟通|已沟通|已投递|已开聊/.test(chatText)) {
    return { pass: false, shouldApply: false, score: 0, status: "skipped", reason: `已沟通: ${chatText}`, reasons: [`已沟通: ${chatText}`], warnings };
  }
  if (hardBlock) {
    return { pass: false, shouldApply: false, score: 0, status: "skipped", reason: hardBlock, reasons: [hardBlock], warnings };
  }
  if (salary.min == null || salary.min < Number(config.minSalaryK || 12)) {
    return {
      pass: false,
      shouldApply: false,
      score: 0,
      status: "skipped",
      reason: `薪资低于 ${config.minSalaryK || 12}K: ${salary.raw || "未知"}`,
      reasons: [`薪资低于 ${config.minSalaryK || 12}K`],
      warnings,
    };
  }
  if (experience && !config.allowedExperience.includes(experience)) {
    return {
      pass: false,
      shouldApply: false,
      score: 0,
      status: "skipped",
      reason: `经验要求偏高: ${experience}`,
      reasons: [`经验要求偏高: ${experience}`],
      warnings,
    };
  }
  const titleLooksBackend = /java|后端|后台|服务端|软件开发|开发工程师/i.test(title || text);
  const queryMatchesJavaBackend = /java/i.test(query) && /后端|后台|服务端|开发工程师/i.test(title || text);
  const explicitJavaStack = /Java|Spring|SpringBoot|Spring Cloud|SpringCloud|MyBatis|JVM|Dubbo|Nacos|Feign/i.test(text);
  if (!titleLooksBackend && !queryMatchesJavaBackend) {
    return { pass: false, shouldApply: false, score: 0, status: "skipped", reason: "不是 Java/后端主方向", reasons: ["不是 Java/后端主方向"], warnings };
  }
  if (detail && !explicitJavaStack && !/java/i.test(title) && !queryMatchesJavaBackend) {
    warnings.push("Java 技术栈不够明确");
    score -= 8;
  }
  if (/一周前活跃|半个月|月前活跃|几个月|长期未活跃/.test(text)) {
    warnings.push("HR 活跃度偏低");
    score -= 10;
  }

  score += Math.min(20, techHits.length * 4);
  score += Math.min(18, domainHits.length * 5);
  if (active) score += 8;
  if (salary.min >= 15) score += 6;
  if (salary.min >= 20) score += 6;
  if (experience === "经验不限" || experience === "应届" || experience === "1年以内") score += 6;
  if (experience === "3-5年") score -= 4;

  const quality = scoreCompany(text, salary.min || 0, config);
  score += quality.score;
  if (config.qualityMode === "better" && !quality.pass) {
    warnings.push(quality.reason);
    score -= 8;
  }

  if (active) reasons.push(active);
  if (queryMatchesJavaBackend) reasons.push(`搜索: ${query}`);
  if (quality.reason) reasons.push(quality.reason);
  if (domainHits.length) reasons.push(`业务: ${domainHits.slice(0, 3).join("/")}`);
  if (techHits.length) reasons.push(`技术: ${techHits.slice(0, 4).join("/")}`);
  if (experience) reasons.push(`经验: ${experience}`);

  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const threshold = config.qualityMode === "better" ? 55 : 50;
  return {
    pass: boundedScore >= threshold,
    shouldApply: boundedScore >= threshold,
    score: boundedScore,
    status: boundedScore >= threshold ? "ready" : "review",
    reason: reasons.join(" / ") || "Java 后端匹配",
    reasons,
    warnings,
    salary,
    experience,
    techHits,
    domainHits,
  };
}

export async function listLogFiles(rootDir) {
  const files = await fs.readdir(rootDir);
  const logs = [];
  for (const file of files) {
    if (!/^boss-150-java.*log\.md$/.test(file)) continue;
    const fullPath = path.join(rootDir, file);
    const stat = await fs.stat(fullPath);
    logs.push({ file, path: fullPath, updatedAt: stat.mtime.toISOString(), size: stat.size });
  }
  return logs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function parseLogText(text = "", source = "") {
  const rows = [];
  let applied = 0;
  let skipped = 0;
  let currentQuery = "";
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const query = line.match(/^###\s+Query:\s*(.+)$/);
    if (query) {
      currentQuery = query[1].trim();
      continue;
    }

    const sent = line.match(/^(\d+)\.\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/);
    if (sent) {
      applied += 1;
      rows.push({
        id: `${source}:${sent[1]}`,
        source,
        index: Number(sent[1]),
        query: currentQuery,
        status: "applied",
        company: normalizeText(sent[2]),
        title: normalizeText(sent[3]),
        salary: normalizeText(sent[4]),
        location: normalizeText(sent[5]),
        reason: normalizeText(sent[6]),
      });
      continue;
    }

    const skip = line.match(/^-\s*skipped:\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/i);
    if (skip) {
      skipped += 1;
      rows.push({
        id: `${source}:skip:${skipped}`,
        source,
        query: currentQuery,
        status: "skipped",
        company: normalizeText(skip[1]),
        title: normalizeText(skip[2]),
        salary: normalizeText(skip[3]),
        location: normalizeText(skip[4]),
        reason: normalizeText(skip[5]),
      });
    }
  }
  return { rows, applied, skipped };
}

export async function readAllLogCandidates(rootDir) {
  const logs = await listLogFiles(rootDir);
  const allRows = [];
  const summaries = [];
  for (const log of logs) {
    const text = await fs.readFile(log.path, "utf8");
    const parsed = parseLogText(text, log.file);
    summaries.push({ ...log, applied: parsed.applied, skipped: parsed.skipped });
    allRows.push(...parsed.rows);
  }
  return { logs: summaries, candidates: allRows };
}
