#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const logPath = process.env.BOSS_LOG_PATH
  ? path.resolve(root, process.env.BOSS_LOG_PATH)
  : path.join(root, "boss-150-java-application-log.md");
const target = Number(process.env.BOSS_TARGET || process.argv[2] || 150);
const delayBase = Number(process.env.BOSS_DELAY_MS || 1800);
const maxPagesPerQuery = Number(process.env.BOSS_MAX_PAGES || 3);
const betterCompanyMode = /^(1|true|yes|better|quality|good)$/i.test(
  process.env.BOSS_COMPANY_MODE || process.env.BOSS_QUALITY_MODE || "",
);

const queries = [
  "Java 急招",
  "急招 Java",
  "Java 今日",
  "Java 最新",
  "Java 新岗位",
  "Java",
  "Java开发",
  "Java后端",
  "Java工程师",
  "后端开发",
  "服务端开发",
  "SpringBoot",
  "微服务 Java",
  "支付 Java",
  "清结算 Java",
  "供应链 Java",
  "ERP Java",
  "订单 Java",
  "金融 Java",
  "电商 Java",
  "SaaS Java",
  "云计算 Java",
  "AI Java",
  "工业互联网 Java",
  "物联网 Java",
  "Java RocketMQ",
  "Java SpringCloud",
  "Java Redis",
  "Java 校招",
  "Java 26届",
  "Java 应届",
  "Java 初级",
  "初级 Java",
  "Java 1-3年",
  "Java 经验不限",
  "Java 软件开发",
  "Java 研发",
];

const cityPlans = [
  { label: "Hangzhou", code: "101210100" },
  { label: "nationwide", code: "100010000" },
  { label: "Shanghai", code: "101020100" },
  { label: "Beijing", code: "101010100" },
  { label: "Shenzhen", code: "101280600" },
  { label: "Guangzhou", code: "101280100" },
  { label: "Nanjing", code: "101190100" },
  { label: "Suzhou", code: "101190400" },
  { label: "Chengdu", code: "101270100" },
  { label: "Wuhan", code: "101200100" },
  { label: "Xi'an", code: "101110100" },
  { label: "Wuxi", code: "101190200" },
  { label: "Ningbo", code: "101210400" },
  { label: "Hefei", code: "101220100" },
  { label: "Changsha", code: "101250100" },
  { label: "Xiamen", code: "101230200" },
  { label: "Fuzhou", code: "101230100" },
  { label: "Qingdao", code: "101120200" },
  { label: "Jinan", code: "101120100" },
  { label: "Tianjin", code: "101030100" },
  { label: "Chongqing", code: "101040100" },
  { label: "Zhengzhou", code: "101180100" },
  { label: "Dongguan", code: "101281600" },
  { label: "Foshan", code: "101280800" },
];

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

const hardNegativeWords = [
  "实习",
  "实习生",
  "实习转正",
  "intern",
  "管培",
  "管培生",
  "储备干部",
  "博士",
  "架构师",
  "专家",
  "技术总监",
  "技术主管",
  "技术组长",
  "团队管理",
  "负责人",
  "合伙人",
  "讲师",
  "导师",
  "非开发岗",
  "交付导师",
  "od岗位",
  "驻日本",
  "出差",
  "短期",
  "项目制",
];

const outsourcingSignals = [
  "外包",
  "驻场",
  "外派",
  "派遣",
  "客户现场",
  "项目现场",
  "人力外包",
  "人力资源",
  "人才科技",
  "人才服务",
  "招聘服务",
  "外企德科",
  "法本",
  "中软国际",
  "软通动力",
  "博彦科技",
  "新致软件",
  "汉克时代",
  "纬创软件",
  "佰钧成",
  "易宝软件",
  "人瑞",
  "东软",
  "亿达信息",
  "京北方",
  "万宝盛华",
  "德科",
  "德科信息",
  "CLPS",
  "华钦",
  "独创时代",
];

const positiveTech = [
  "Java",
  "Spring",
  "SpringBoot",
  "Spring Cloud",
  "SpringCloud",
  "MyBatis",
  "MySQL",
  "Redis",
  "RocketMQ",
  "Kafka",
  "RabbitMQ",
  "XXL-Job",
  "微服务",
  "分布式",
  "Docker",
  "Kubernetes",
  "JVM",
  "Dubbo",
  "Nacos",
];

const positiveDomain = [
  "支付",
  "清结算",
  "结算",
  "对账",
  "资金",
  "银行",
  "金融",
  "交易",
  "订单",
  "ERP",
  "供应链",
  "采购",
  "仓储",
  "履约",
  "WMS",
  "物流",
  "SaaS",
  "工业",
  "物联网",
  "IoT",
  "智能硬件",
  "机器人",
  "新能源",
  "云平台",
  "中间件",
];

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
  "国泰君安",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms = delayBase) {
  return ms + Math.floor(Math.random() * 900);
}

function decodeBossText(text = "") {
  return [...text].map((char) => obfuscatedDigits[char] ?? char).join("");
}

function normalize(text = "") {
  return decodeBossText(text).replace(/\s+/g, " ").trim();
}

function osa(js) {
  const wrapped = `(() => {
    try {
      const value = (() => { ${js} })();
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error), stack: error && error.stack });
    }
  })()`;
  const script = `tell application id "com.google.Chrome"
  set targetWindowIndex to 0
  set targetTabIndex to 0
  repeat with wi from 1 to count of windows
    repeat with ti from 1 to count of tabs of window wi
      set tabUrl to URL of tab ti of window wi
      if tabUrl contains "zhipin.com" then
        set targetWindowIndex to wi
        set targetTabIndex to ti
        exit repeat
      end if
    end repeat
    if targetWindowIndex is not 0 then exit repeat
  end repeat
  if targetWindowIndex is 0 then
    make new window
    set URL of active tab of front window to "https://www.zhipin.com/web/geek/jobs"
    delay 1
    set targetWindowIndex to 1
    set targetTabIndex to active tab index of front window
  end if
  set index of window targetWindowIndex to 1
  set active tab index of front window to targetTabIndex
  activate
  execute active tab of front window javascript ${JSON.stringify(wrapped)}
end tell`;
  const output = execFileSync("osascript", ["-e", script], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  }).trim();
  const parsed = JSON.parse(output || "{}");
  if (!parsed.ok) {
    throw new Error(`${parsed.error}\n${parsed.stack || ""}`);
  }
  return parsed.value;
}

function appendLog(line) {
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

function readAppliedCount() {
  if (!fs.existsSync(logPath)) return 0;
  const text = fs.readFileSync(logPath, "utf8");
  const matches = [...text.matchAll(/^\d+\.\s/mg)];
  return matches.length;
}

function loadAppliedKeys() {
  const seen = new Set();
  const files = [
    logPath,
    ...(process.env.BOSS_DEDUPE_LOGS || "")
      .split(/[:,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(root, item)),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\d+\.\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/);
      if (!match) continue;
      const company = match[1].trim();
      const title = match[2].trim();
      const salary = match[3].trim();
      const location = match[4].trim();
      seen.add(`${company}|${title}|${salary}|${location}`);
      seen.add(`${company}|${title}|${salary}`);
    }
  }
  return seen;
}

function updateProgress(applied, blocker = null) {
  if (!fs.existsSync(logPath)) return;
  let text = fs.readFileSync(logPath, "utf8");
  text = text.replace(/- Applied: \d+ \/ \d+/, `- Applied: ${applied} / ${target}`);
  text = text.replace(/- Blockers: .*/, `- Blockers: ${blocker || "none"}`);
  fs.writeFileSync(logPath, text, "utf8");
}

function parseSalaryMin(text) {
  const salary = normalize(text);
  if (/面议/.test(salary)) return null;
  const match = salary.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  if (match) return Number(match[1]);
  const single = salary.match(/(\d+(?:\.\d+)?)\s*K/i);
  if (single) return Number(single[1]);
  return null;
}

function hasAny(text, words) {
  const haystack = String(text || "");
  return words.some((word) => haystack.toLowerCase().includes(word.toLowerCase()));
}

function firstHits(text, words, limit = 3) {
  return words.filter((word) => String(text || "").toLowerCase().includes(word.toLowerCase())).slice(0, limit);
}

function screenCompanyQuality(text, salaryMin) {
  if (!betterCompanyMode) return { pass: true, reason: "" };
  const all = normalize(text);
  const strongCompany = firstHits(all, strongCompanySignals, 2);
  const org = firstHits(all, qualityOrgSignals, 2);
  const domain = firstHits(all, positiveDomain, 2);
  const tech = firstHits(all, positiveTech, 3);
  const platformSignal = /平台|中台|交易|支付|清结算|风控|供应链|ERP|SaaS|云|数据|核心系统|基础架构|中间件/.test(all);

  if (strongCompany.length || org.length) {
    return { pass: true, reason: `better company: ${[...strongCompany, ...org].join("/")}` };
  }
  if (salaryMin >= 18) {
    return { pass: true, reason: "better company: high salary band" };
  }
  if (salaryMin >= 15 && domain.length) {
    return { pass: true, reason: `better company: ${domain.join("/")}` };
  }
  if (salaryMin >= 15 && platformSignal && tech.length >= 2) {
    return { pass: true, reason: `better company: platform/stack ${tech.slice(0, 2).join("/")}` };
  }
  return { pass: false, reason: "company quality below better-mode" };
}

function screenCard(card) {
  const text = normalize(`${card.title} ${card.salary} ${card.meta} ${card.company} ${card.location}`);
  const title = normalize(card.title);
  const salaryMin = parseSalaryMin(card.salary);
  if (hasAny(text, hardNegativeWords)) return { pass: false, reason: "hard exclusion" };
  if (/\bOD\b|OD岗位|外包OD/i.test(text)) return { pass: false, reason: "OD/outsourced role" };
  if (/(\d+\s*个月|半年|短期|项目制)/i.test(text)) return { pass: false, reason: "short-term/project role" };
  if (/\bTL\b|team\s*lead|leader/i.test(text)) return { pass: false, reason: "lead/management role" };
  if (/硕士及以上|硕士以上|研究生及以上|硕士学历|博士/.test(text)) return { pass: false, reason: "degree mismatch" };
  if (/导师|讲师|培训|交付|非开发岗|解决方案|售前|客户成功/.test(title)) {
    return { pass: false, reason: "non-development delivery/training title" };
  }
  if (
    /测开|测试开发|测试|算法测开|算法.*招聘|python.*java|java.*python|java.*go\b|go.*java|php.*java|java.*php|c\+\+.*java|java.*c\+\+|c#.*java|java.*c#|\.net.*java|java.*\.net|cobol.*java|java.*cobol/i.test(
      title,
    )
  ) {
    return { pass: false, reason: "mixed non-Java/test title" };
  }
  if (/(ios|android|安卓|移动端)/i.test(title)) {
    return { pass: false, reason: "mobile client title" };
  }
  if (/(golang|go后端|\bgo\b|c\+\+|python|php|node\.?js|前端)/i.test(title) && !/java/i.test(title)) {
    return { pass: false, reason: "non-Java title" };
  }
  if (/测试工程师|运维工程师|实施工程师|项目经理|销售|客服/.test(text) && !/java|后端|服务端/i.test(text)) {
    return { pass: false, reason: "non-development role" };
  }
  if (hasAny(text, outsourcingSignals)) return { pass: false, reason: "outsourcing signal" };
  if (salaryMin == null || salaryMin < 12) return { pass: false, reason: `salary ${normalize(card.salary) || "unknown"}` };
  if (!/java|后端|服务端|软件开发|开发工程师/i.test(text)) return { pass: false, reason: "not Java/backend title" };
  const quality = screenCompanyQuality(text, salaryMin);
  if (!quality.pass) return quality;
  return { pass: true, reason: "card pass" };
}

function screenDetail(detail) {
  const text = normalize(detail.text);
  const top = normalize(`${detail.title || ""} ${detail.salary || ""} ${detail.location || ""}`);
  const all = `${top} ${text}`;
  const chatText = normalize(detail.chatText || "");
  const javaStack = /Java|Spring|SpringBoot|Spring Cloud|SpringCloud|MyBatis|MyBatis-Plus|JVM|Dubbo|Nacos|Seata|Feign/i.test(all);
  const salaryMin = parseSalaryMin(detail.salary || top);
  if (/继续沟通|已沟通|已投递|已开聊/.test(chatText)) {
    return { pass: false, reason: `already communicated (${chatText})` };
  }
  if (hasAny(all, hardNegativeWords)) return { pass: false, reason: "hard exclusion in detail" };
  if (/\bOD\b|OD岗位|外包OD/i.test(all)) return { pass: false, reason: "OD/outsourced role" };
  if (/(\d+\s*个月|半年|短期|项目制)/i.test(all)) return { pass: false, reason: "short-term/project role" };
  if (/\bTL\b|team\s*lead|leader/i.test(all)) return { pass: false, reason: "lead/management role" };
  if (/硕士及以上|硕士以上|研究生及以上|硕士学历|博士/.test(all)) return { pass: false, reason: "degree mismatch" };
  if (/测试工程师|运维工程师|实施工程师|项目经理|销售|客服/.test(top) && !/java|后端|服务端/i.test(top)) {
    return { pass: false, reason: "non-development role" };
  }
  if (/导师|讲师|培训|交付|非开发岗|解决方案|售前|客户成功/.test(top)) {
    return { pass: false, reason: "non-development delivery/training title" };
  }
  if (
    /测开|测试开发|测试|算法测开|算法.*招聘|python.*java|java.*python|java.*go\b|go.*java|php.*java|java.*php|c\+\+.*java|java.*c\+\+|c#.*java|java.*c#|\.net.*java|java.*\.net|cobol.*java|java.*cobol/i.test(
      top,
    )
  ) {
    return { pass: false, reason: "mixed non-Java/test title" };
  }
  if (/(ios|android|安卓|移动端)/i.test(top)) {
    return { pass: false, reason: "mobile client title" };
  }
  if (/(golang|go后端|\bgo\b|c\+\+|python|php|node\.?js|前端)/i.test(top) && !/java/i.test(top)) {
    return { pass: false, reason: "non-Java title" };
  }
  if (hasAny(all, outsourcingSignals)) return { pass: false, reason: "outsourcing/client-site signal" };
  if (salaryMin == null || salaryMin < 12) return { pass: false, reason: `salary ${normalize(detail.salary || "") || "unknown"}` };
  if (/精通.*架构|架构设计经验/.test(all)) return { pass: false, reason: "architecture-heavy role" };
  if (!javaStack) {
    return { pass: false, reason: "Java not primary enough" };
  }
  if (/一周前活跃|半个月|月前活跃|几个月|长期未活跃/.test(all)) {
    return { pass: false, reason: "HR not fresh" };
  }
  const tech = firstHits(all, positiveTech);
  const domain = firstHits(all, positiveDomain);
  const quality = screenCompanyQuality(all, salaryMin);
  if (!quality.pass) return quality;
  const active = (all.match(/在线|刚刚活跃|今日活跃|3日内活跃|本周活跃/) || [])[0];
  const reason =
    [active, quality.reason, ...domain, ...tech].filter(Boolean).slice(0, 6).join("/") || "Java backend fit";
  return { pass: true, reason };
}

function getCards() {
  return osa(`
    const cards = [...document.querySelectorAll('.job-card-wrap')];
    return cards.map((el, index) => {
      const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const rect = el.getBoundingClientRect();
      return {
        index,
        title: lines[0] || '',
        salary: lines[1] || '',
        meta: lines.slice(2, 4).join(' '),
        company: lines[4] || '',
        location: lines.slice(5).join(' '),
        active: el.classList.contains('active'),
        visible: rect.width > 0 && rect.height > 0
      };
    });
  `).map((card) => ({
    ...card,
    decodedTitle: normalize(card.title),
    decodedSalary: normalize(card.salary),
    decodedCompany: normalize(card.company),
    decodedMeta: normalize(card.meta),
    decodedLocation: normalize(card.location),
  }));
}

function getDetail() {
  const detail = osa(`
    const box = document.querySelector('.job-detail-container') || document.querySelector('.job-detail-box');
    const text = box ? box.innerText || '' : document.body.innerText || '';
    const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
    const chat = box ? box.querySelector('.op-btn-chat') : document.querySelector('.op-btn-chat');
    const active = document.querySelector('.job-card-wrap.active');
    const activeLines = active ? (active.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean) : [];
    return {
      title: lines[0] || activeLines[0] || '',
      salary: lines[1] || activeLines[1] || '',
      location: lines[2] || activeLines.slice(5).join(' ') || '',
      text: text.slice(0, 5000),
      chatText: chat ? chat.innerText || '' : '',
      chatClass: chat ? chat.className || '' : '',
      activeTitle: activeLines[0] || '',
      activeSalary: activeLines[1] || '',
      url: location.href,
      bodyHead: (document.body.innerText || '').slice(0, 600)
    };
  `);
  return {
    ...detail,
    titleDecoded: normalize(detail.title),
    salaryDecoded: normalize(detail.salary),
    locationDecoded: normalize(detail.location),
  };
}

async function waitForDetail(card, timeoutMs = 8500) {
  const started = Date.now();
  const expectedTitle = normalize(card.decodedTitle || card.title);
  const expectedSalary = normalize(card.decodedSalary || card.salary);
  let lastDetail = null;

  while (Date.now() - started < timeoutMs) {
    lastDetail = getDetail();
    const actualTitle = normalize(lastDetail.titleDecoded || lastDetail.title);
    const actualSalary = normalize(lastDetail.salaryDecoded || lastDetail.salary);
    const titleMatches =
      expectedTitle &&
      actualTitle &&
      (actualTitle.includes(expectedTitle) ||
        expectedTitle.includes(actualTitle) ||
        (expectedTitle.length <= 6 && actualTitle.includes(expectedTitle.slice(0, 4))));
    const salaryMatches = expectedSalary && actualSalary && actualSalary === expectedSalary;

    if (salaryMatches && titleMatches) return { ...lastDetail, detailReady: true };
    if (salaryMatches && expectedTitle.length <= 4) return { ...lastDetail, detailReady: true };
    await sleep(650);
  }

  return { ...(lastDetail || getDetail()), detailReady: false };
}

function clickCard(index) {
  return osa(`
    const cards = [...document.querySelectorAll('.job-card-wrap')];
    const el = cards[${Number(index)}];
    if (!el) return { clicked: false, reason: 'card not found' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const target = el.querySelector('a.job-name') || el.querySelector('.job-card-box') || el;
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    target.click();
    return { clicked: true, text: el.innerText || '' };
  `);
}

function clickChat() {
  return osa(`
    const box = document.querySelector('.job-detail-container') || document.querySelector('.job-detail-box');
    const button = box ? box.querySelector('.op-btn-chat') : document.querySelector('.op-btn-chat');
    if (!button) return { clicked: false, reason: 'chat button not found' };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return { clicked: true, text: button.innerText || '', className: button.className || '' };
  `);
}

function handleAfterChat() {
  return osa(`
    const bodyText = document.body.innerText || '';
    const exact = (text) => [...document.querySelectorAll('button,a,span,div')].find(el => (el.innerText || '').trim() === text);
    const stay = exact('留在此页');
    const know = exact('知道了') || exact('我知道了') || exact('确定');
    const close = document.querySelector('.boss-dialog-close, .dialog-close, .close');
    if (stay) {
      stay.click();
      return { action: 'stay', bodyText: bodyText.slice(0, 700) };
    }
    if (know && /已向|发送|沟通|上限|今日|次数|验证码|安全/.test(bodyText)) {
      know.click();
      return { action: 'ack', bodyText: bodyText.slice(0, 700) };
    }
    if (close && /已向|发送|沟通/.test(bodyText)) {
      close.click();
      return { action: 'close', bodyText: bodyText.slice(0, 700) };
    }
    return { action: 'none', bodyText: bodyText.slice(0, 1000) };
  `);
}

function scrollList() {
  return osa(`
    const scroller = document.querySelector('.job-list-container') || document.querySelector('.recommend-result-job') || document.scrollingElement;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(540, scroller.clientHeight * 0.85);
    return { before, after: scroller.scrollTop, max: scroller.scrollHeight, client: scroller.clientHeight };
  `);
}

function gotoNextPage() {
  return osa(`
    const links = [...document.querySelectorAll('a, button')];
    const next = links.find(el => /下一页|next/i.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (next && !/disabled/.test(next.className || '')) {
      next.click();
      return { clicked: true, text: next.innerText || '' };
    }
    return { clicked: false };
  `);
}

function navigateQuery(query, cityCode = "") {
  const params = new URLSearchParams({ query });
  if (cityCode) params.set("city", cityCode);
  const url = `https://www.zhipin.com/web/geek/jobs?${params.toString()}`;
  return osa(`
    location.href = ${JSON.stringify(url)};
    return location.href;
  `);
}

function pageHealth() {
  return osa(`
    const body = document.body.innerText || '';
    return {
      title: document.title,
      url: location.href,
      hasCards: !!document.querySelector('.job-card-wrap'),
      cardCount: document.querySelectorAll('.job-card-wrap').length,
      hasChat: !!document.querySelector('.op-btn-chat'),
      head: body.slice(0, 800)
    };
  `);
}

function noteSkip(card, reason) {
  const company = card.decodedCompany || normalize(card.company);
  const title = card.decodedTitle || normalize(card.title);
  const salary = card.decodedSalary || normalize(card.salary);
  const location = card.decodedLocation || normalize(card.location);
  appendLog(`- skipped: ${company} | ${title} | ${salary} | ${location} | ${reason}`);
}

function noteApplied(applied, card, detail, reason) {
  const company = card.decodedCompany || normalize(card.company);
  const title = detail.titleDecoded || card.decodedTitle || normalize(card.title);
  const salary = detail.salaryDecoded || card.decodedSalary || normalize(card.salary);
  const location = detail.locationDecoded || card.decodedLocation || normalize(card.location);
  appendLog(`${applied}. ${company} | ${title} | ${salary} | ${location} | ${reason}`);
}

async function ensurePageReady() {
  const health = pageHealth();
  console.log(`Page: ${health.title} | ${health.url}`);
  if (/验证码|安全验证|扫码登录|手机验证码|请先登录|登录后继续|账号异常|访问受限|风险验证/.test(health.head)) {
    updateProgress(readAppliedCount(), "security/login/CAPTCHA prompt");
    throw new Error(`BOSS is blocked by login/security prompt: ${normalize(health.head.slice(0, 200))}`);
  }
  if (!health.hasCards) {
    await sleep(3500);
    const retry = pageHealth();
    if (!retry.hasCards) {
      console.log(`No job cards loaded: ${normalize(retry.head.slice(0, 260))}`);
      appendLog(`- no cards: ${normalize(retry.url)} | ${normalize(retry.head.slice(0, 160))}`);
      return false;
    }
  }
  return true;
}

async function applyCurrentPage(query, seen) {
  let applied = readAppliedCount();
  let staleScrolls = 0;

  for (let safety = 0; safety < 90 && applied < target; safety += 1) {
    const cards = getCards();
    let touched = false;
    console.log(`Visible cards: ${cards.length}, applied ${applied}/${target}`);

    for (const card of cards) {
      if (applied >= target) break;
      const key = `${card.decodedCompany}|${card.decodedTitle}|${card.decodedSalary}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cardScreen = screenCard(card);
      if (!cardScreen.pass) {
        noteSkip(card, cardScreen.reason);
        continue;
      }

      touched = true;
      clickCard(card.index);
      await sleep(jitter(900));

      const detail = await waitForDetail(card);
      if (detail.detailReady === false) {
        noteSkip(card, "detail did not refresh");
        continue;
      }
      const detailScreen = screenDetail(detail);
      if (detailScreen.stop) {
        updateProgress(applied, detailScreen.reason);
        throw new Error(detailScreen.reason);
      }
      if (!detailScreen.pass) {
        noteSkip(card, detailScreen.reason);
        continue;
      }

      const chat = clickChat();
      await sleep(jitter(2200));
      const modal = handleAfterChat();
      await sleep(jitter(900));

      const modalText = normalize(modal.bodyText || "");
      if (/验证码|安全验证|手机验证码|扫码登录|请先登录|登录后继续|账号异常|访问受限|风险验证/.test(modalText)) {
        updateProgress(applied, "security/login/CAPTCHA prompt after chat click");
        throw new Error("security/login/CAPTCHA prompt after chat click");
      }
      if (/(今日|当天).{0,24}(沟通|开聊|打招呼).{0,24}(上限|已达|次数|限制)|((沟通|开聊|打招呼).{0,24}(上限|限制|次数已用完))|(已达.{0,16}(上限|限制))/.test(modalText)) {
        updateProgress(applied, "daily communication limit");
        throw new Error(`daily communication limit: ${modalText.slice(0, 160)}`);
      }

      const initialChatText = normalize(chat.text || "");
      const success =
        /已向|发送|留在此页|已沟通|继续沟通|新开聊/.test(modalText) ||
        (chat.clicked && /立即沟通|沟通/.test(initialChatText));
      if (!success) {
        noteSkip(card, `chat uncertain: ${modalText.slice(0, 80)}`);
        continue;
      }

      applied += 1;
      updateProgress(applied);
      noteApplied(applied, card, detail, detailScreen.reason);
      console.log(`Applied ${applied}/${target}: ${card.decodedCompany} | ${detail.titleDecoded || card.decodedTitle} | ${detail.salaryDecoded || card.decodedSalary}`);
      await sleep(jitter(1200));
    }

    if (applied >= target) break;
    const scroll = scrollList();
    await sleep(jitter(1700));
    if (scroll.after === scroll.before || scroll.after + scroll.client >= scroll.max - 20) {
      staleScrolls += 1;
    } else {
      staleScrolls = 0;
    }

    if (!touched && staleScrolls >= 2) {
      console.log(`No more useful visible roles for query "${query}" on this scroll window.`);
      break;
    }
  }

  return applied;
}

async function main() {
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(
      logPath,
      `# BOSS Java Application Log\n\n- Date: ${new Date().toISOString()}\n- Mode: fresh/new-posting priority; dedupe prior logs; no plugin; Google Chrome AppleScript\n- Applied: 0 / ${target}\n- Blockers: none\n\n## Applied\n\n## Skipped / Notes\n`,
      "utf8",
    );
  }

  const seen = loadAppliedKeys();
  let applied = readAppliedCount();
  updateProgress(applied);
  const startCity = process.env.BOSS_START_CITY || "";
  const startQuery = process.env.BOSS_START_QUERY || "";
  const startCityIndex = startCity
    ? Math.max(0, cityPlans.findIndex((city) => city.label === startCity || city.code === startCity))
    : 0;
  const activeCityPlans = cityPlans.slice(startCityIndex < 0 ? 0 : startCityIndex);

  for (const [cityOffset, city] of activeCityPlans.entries()) {
    if (applied >= target) break;
    const queryStartIndex =
      startQuery && cityOffset === 0 ? Math.max(0, queries.findIndex((query) => query === startQuery)) : 0;
    for (const query of queries.slice(queryStartIndex < 0 ? 0 : queryStartIndex)) {
      if (applied >= target) break;
      const label = `${city.label}:${query}`;
      console.log(`\n=== Query: ${label} ===`);
      appendLog(`\n### Query: ${label}`);
      navigateQuery(query, city.code);
      await sleep(jitter(5200));
      const ready = await ensurePageReady();
      if (!ready) continue;

      for (let page = 1; page <= maxPagesPerQuery && applied < target; page += 1) {
        applied = await applyCurrentPage(label, seen);
        if (applied >= target) break;
        const next = gotoNextPage();
        if (!next.clicked) break;
        console.log(`Next page for ${label}`);
        await sleep(jitter(4500));
        const nextReady = await ensurePageReady();
        if (!nextReady) break;
      }
    }
  }

  updateProgress(applied, applied >= target ? null : "target not reached; visible query lanes exhausted");
  console.log(`Done. Applied ${applied}/${target}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
