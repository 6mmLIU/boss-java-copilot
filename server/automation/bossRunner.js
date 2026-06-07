import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { defaultConfig } from "../lib/defaults.js";
import { detectSecurityBlocker, normalizeText, readAllLogCandidates, screenJob } from "../lib/rules.js";

const SEARCH_BASE = "https://www.zhipin.com/web/geek/jobs";
const LOGIN_URL = "https://www.zhipin.com/web/user/?ka=header-login";
const LOGIN_CHECK_URL = `${SEARCH_BASE}?query=Java&city=100010000`;
const LOGIN_REQUIRED = "login required; finish login in the opened BOSS window before running";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeFileStamp() {
  return nowIso().replace(/[:.]/g, "-");
}

export class BossRunner extends EventEmitter {
  constructor({ rootDir }) {
    super();
    this.rootDir = rootDir;
    this.context = null;
    this.page = null;
    this.abortRequested = false;
    this.status = {
      state: "idle",
      message: "Ready",
      applied: 0,
      screened: 0,
      skipped: 0,
      blocker: "",
      currentQuery: "",
      currentCity: "",
      logFile: "",
      startedAt: "",
      updatedAt: nowIso(),
    };
  }

  getStatus() {
    return { ...this.status };
  }

  updateStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: nowIso() };
    this.emit("status", this.getStatus());
  }

  emitLog(message, level = "info") {
    const payload = { level, message, at: nowIso() };
    this.emit("log", payload);
  }

  async ensureContext(config = defaultConfig) {
    if (this.context && this.page && !this.page.isClosed()) return this.page;

    const profileDir = path.resolve(this.rootDir, config.profileDir || "data/browser-profile");
    await fs.mkdir(profileDir, { recursive: true });
    const launchOptions = {
      headless: Boolean(config.headless),
      viewport: { width: 1440, height: 960 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"],
    };
    if (config.browserChannel === "chrome") {
      launchOptions.channel = "chrome";
    }

    this.context = await chromium.launchPersistentContext(profileDir, launchOptions);
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(9000);
    this.page.on("close", () => {
      this.page = null;
    });
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });
    return this.page;
  }

  async preflight(config = defaultConfig) {
    this.updateStatus({ state: "preflight", message: "Checking BOSS login before run" });
    const result = await this.requireLoggedIn(config);
    if (!result.ok) return result;
    this.updateStatus({ state: "idle", blocker: "", message: "Browser ready" });
    this.emitLog("Preflight passed");
    return result;
  }

  async start(configInput = {}) {
    if (this.status.state === "running") {
      return this.getStatus();
    }
    const config = this.normalizeConfig(configInput);
    this.abortRequested = false;
    const login = await this.requireLoggedIn(config);
    if (!login.ok) {
      return this.getStatus();
    }
    const runLog = path.join(this.rootDir, "data", "runs", `boss-java-run-${safeFileStamp()}.md`);
    await fs.mkdir(path.dirname(runLog), { recursive: true });
    await fs.writeFile(
      runLog,
      [
        "# BOSS Java Copilot Run",
        "",
        `- Started: ${nowIso()}`,
        `- Mode: ${config.mode}`,
        `- Target: ${config.target}`,
        `- Browser: ${config.browserChannel}`,
        "",
        "## Events",
        "",
      ].join("\n"),
      "utf8",
    );
    this.updateStatus({
      state: "running",
      message: "Run started",
      applied: 0,
      screened: 0,
      skipped: 0,
      blocker: "",
      logFile: path.relative(this.rootDir, runLog),
      startedAt: nowIso(),
    });
    this.run(config, runLog).catch((error) => {
      const browserClosed = isBrowserClosedError(error);
      this.updateStatus({
        state: browserClosed ? "blocked" : "error",
        message: browserClosed ? "Automation browser was closed" : error.message,
        blocker: browserClosed ? "automation browser closed; run preflight again" : error.message,
      });
      this.emitLog(error.stack || error.message, "error");
    });
    return this.getStatus();
  }

  async stop(reason = "stopped by user") {
    this.abortRequested = true;
    this.updateStatus({ state: "stopping", message: reason });
    this.emitLog(reason, "warn");
    return this.getStatus();
  }

  async closeBrowser() {
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    this.context = null;
    this.page = null;
    this.updateStatus({ state: "idle", message: "Browser closed" });
  }

  normalizeConfig(configInput) {
    const merged = {
      ...defaultConfig,
      ...configInput,
      cities: Array.isArray(configInput.cities) ? configInput.cities : defaultConfig.cities,
      queries: Array.isArray(configInput.queries) ? configInput.queries : defaultConfig.queries,
    };
    return {
      ...merged,
      target: Math.max(1, Number(merged.target || 30)),
      delayMs: Math.max(250, Number(merged.delayMs || 900)),
      maxPagesPerQuery: Math.max(1, Number(merged.maxPagesPerQuery || 2)),
    };
  }

  async run(config, runLog) {
    const page = await this.ensureContext(config);
    const { candidates: historical } = await readAllLogCandidates(this.rootDir).catch(() => ({ candidates: [] }));
    const seen = new Set(historical.map((item) => candidateKey(item)));
    const cities = config.cities.filter((city) => city.enabled !== false);
    const queries = config.queries.filter(Boolean);
    let applied = 0;
    let screened = 0;
    let skipped = 0;

    for (const city of cities) {
      for (const query of queries) {
        if (this.shouldStop(applied, config.target)) break;
        this.updateStatus({ currentCity: city.label, currentQuery: query, message: `Searching ${city.label} / ${query}` });
        await this.appendRun(runLog, `### Query: ${city.label}:${query}`);
        await this.gotoSearch(page, query, city);

        for (let pageIndex = 1; pageIndex <= config.maxPagesPerQuery; pageIndex += 1) {
          if (this.shouldStop(applied, config.target)) break;
          const blocker = await this.detectPageBlocker(page);
          if (blocker) {
            await this.block(runLog, blocker, page);
            return;
          }

          const cards = await this.collectCards(page);
          this.emitLog(`Found ${cards.length} visible cards on page ${pageIndex}`);
          if (!cards.length) break;

          for (const card of cards) {
            if (this.shouldStop(applied, config.target)) break;
            const key = candidateKey(card);
            if (seen.has(key)) {
              skipped += 1;
              this.updateStatus({ skipped, screened });
              continue;
            }
            seen.add(key);
            screened += 1;

            const cardScreen = screenJob(card, config);
            if (!cardScreen.pass) {
              skipped += 1;
              this.emit("candidate", { ...card, screen: cardScreen, status: "skipped" });
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${cardScreen.reason}`);
              this.updateStatus({ screened, skipped });
              continue;
            }

            await this.clickCard(page, card.index);
            await delay(config.delayMs);
            const detail = await this.readDetail(page);
            const detailScreen = screenJob({ ...card, ...detail, detailText: detail.text }, config);
            const candidate = { ...card, ...detail, screen: detailScreen };
            this.emit("candidate", candidate);

            if (!detailScreen.pass) {
              skipped += 1;
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${detailScreen.reason}`);
              this.updateStatus({ screened, skipped });
              continue;
            }

            if (config.mode === "review") {
              await this.appendRun(runLog, `- ready: ${formatCandidate(card)} | ${detailScreen.reason}`);
              this.emitLog(`Review ready: ${card.company} / ${card.title}`);
              this.updateStatus({ screened, skipped, message: "Review candidate collected" });
              continue;
            }

            const sent = await this.clickChat(page);
            if (sent.blocker) {
              await this.block(runLog, sent.blocker, page);
              return;
            }
            if (!sent.ok) {
              skipped += 1;
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${sent.reason || "chat button unavailable"}`);
              this.updateStatus({ screened, skipped });
              continue;
            }
            applied += 1;
            await this.appendRun(runLog, `${applied}. ${formatCandidate(card)} | ${detailScreen.reason}`);
            this.emit("applied", { ...candidate, appliedIndex: applied });
            this.updateStatus({ applied, screened, skipped, message: `Applied ${applied} / ${config.target}` });
            await delay(config.delayMs + 450);
          }

          if (this.shouldStop(applied, config.target)) break;
          const moved = await this.nextPage(page);
          if (!moved) break;
          await delay(config.delayMs + 600);
        }
      }
    }

    const state = applied >= config.target ? "done" : this.abortRequested ? "idle" : "done";
    const message = applied >= config.target ? "Target reached" : this.abortRequested ? "Stopped" : "Run finished";
    await this.appendRun(runLog, `\n- Finished: ${nowIso()}`);
    await this.appendRun(runLog, `- Applied: ${applied} / ${config.target}`);
    await this.appendRun(runLog, `- Screened: ${screened}`);
    await this.appendRun(runLog, `- Skipped: ${skipped}`);
    this.updateStatus({ state, applied, screened, skipped, message, currentCity: "", currentQuery: "" });
  }

  shouldStop(applied, target) {
    return this.abortRequested || applied >= target;
  }

  async gotoSearch(page, query, city) {
    const url = `${SEARCH_BASE}?query=${encodeURIComponent(query)}&city=${encodeURIComponent(city.code || city.key || city.label)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.mouse.wheel(0, 300).catch(() => {});
  }

  async detectPageBlocker(page) {
    const body = normalizeText(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    return detectSecurityBlocker(body);
  }

  async requireLoggedIn(config) {
    const page = await this.ensureContext(config);
    const inspected = await this.inspectLoginState(page);
    if (inspected.ok) {
      this.emitLog("Login gate passed");
      return { ok: true, url: page.url() };
    }

    await this.openLoginPage(page);
    const blocker = inspected.blocker || LOGIN_REQUIRED;
    this.updateStatus({
      state: "blocked",
      blocker,
      message: "Please log in in the opened BOSS window before running",
      currentCity: "",
      currentQuery: "",
    });
    this.emitLog(`Login gate blocked: ${blocker}`, "warn");
    return { ok: false, blocker, url: page.url() };
  }

  async inspectLoginState(page) {
    if (!page || page.isClosed()) {
      return { ok: false, blocker: "automation browser closed; run preflight again" };
    }

    await page.goto(LOGIN_CHECK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.bringToFront().catch(() => {});

    const signals = await page
      .evaluate(() => {
        const visibleText = (document.body.innerText || "").replace(/\s+/g, " ").trim();
        const bodyHead = visibleText.slice(0, 3000);
        const cardCount = document.querySelectorAll(".job-card-wrap").length;
        const chatButtonCount = document.querySelectorAll(".op-btn-chat").length;
        const loginControlCount = [...document.querySelectorAll("a, button, .btn, .nav-item, .login-btn, .header-login")]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && /登录|注册|扫码|验证码|微信|手机号/.test(el.innerText || "");
          })
          .length;
        return { bodyHead, cardCount, chatButtonCount, loginControlCount };
      })
      .catch(() => ({ bodyHead: "", cardCount: 0, chatButtonCount: 0, loginControlCount: 0 }));

    const bodyHead = normalizeText(signals.bodyHead);
    const blocker = detectSecurityBlocker(bodyHead);
    const loginText = /登录|注册|扫码|验证码|微信登录|手机号登录|密码登录|登录 \/ 注册|BOSS直聘 APP/.test(bodyHead);
    const loginControlsVisible = signals.loginControlCount > 0;
    const looksLoggedOut = Boolean(blocker) || page.url().includes("/web/user") || loginControlsVisible || (loginText && signals.cardCount === 0);

    if (looksLoggedOut) {
      return { ok: false, blocker: blocker || LOGIN_REQUIRED, signals };
    }
    if (signals.cardCount > 0 || signals.chatButtonCount > 0) {
      return { ok: true, signals };
    }
    return { ok: false, blocker: LOGIN_REQUIRED, signals };
  }

  async openLoginPage(page) {
    if (!page || page.isClosed()) return;
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => page.goto(SEARCH_BASE, { waitUntil: "domcontentloaded" }));
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
  }

  async collectCards(page) {
    if (!page || page.isClosed()) {
      throw new Error("automation browser closed; run preflight again");
    }
    try {
      return await page
        .locator(".job-card-wrap")
        .evaluateAll((nodes) =>
          nodes.map((el, index) => {
            const lines = (el.innerText || "")
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            const rect = el.getBoundingClientRect();
            return {
              index,
              title: lines[0] || "",
              salary: lines[1] || "",
              meta: lines.slice(2, 4).join(" "),
              company: lines[4] || "",
              location: lines.slice(5).join(" "),
              visible: rect.width > 0 && rect.height > 0,
            };
          }),
        )
        .then((cards) =>
          cards
            .filter((card) => card.visible)
            .map((card) => ({
              ...card,
              title: normalizeText(card.title),
              salary: normalizeText(card.salary),
              meta: normalizeText(card.meta),
              company: normalizeText(card.company),
              location: normalizeText(card.location),
            })),
        );
    } catch (error) {
      if (isBrowserClosedError(error)) {
        throw new Error("automation browser closed; run preflight again");
      }
      throw error;
    }
  }

  async clickCard(page, index) {
    const card = page.locator(".job-card-wrap").nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const title = card.locator("a.job-name").first();
    if (await title.count()) {
      await title.click({ timeout: 6000 });
    } else {
      await card.click({ timeout: 6000 });
    }
  }

  async readDetail(page) {
    return page.evaluate(() => {
      const box = document.querySelector(".job-detail-container") || document.querySelector(".job-detail-box");
      const text = box ? box.innerText || "" : document.body.innerText || "";
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const chat = box ? box.querySelector(".op-btn-chat") : document.querySelector(".op-btn-chat");
      return {
        title: lines[0] || "",
        salary: lines[1] || "",
        location: lines[2] || "",
        text: text.slice(0, 6000),
        chatText: chat ? chat.innerText || "" : "",
      };
    }).then((detail) => ({
      ...detail,
      title: normalizeText(detail.title),
      salary: normalizeText(detail.salary),
      location: normalizeText(detail.location),
      text: normalizeText(detail.text),
      chatText: normalizeText(detail.chatText),
    }));
  }

  async clickChat(page) {
    const blockerBefore = await this.detectPageBlocker(page);
    if (blockerBefore) return { ok: false, blocker: blockerBefore };
    const button = page.locator(".job-detail-container .op-btn-chat, .job-detail-box .op-btn-chat, .op-btn-chat").first();
    if (!(await button.count())) return { ok: false, reason: "no chat button" };
    const text = normalizeText(await button.innerText().catch(() => ""));
    if (/继续沟通|已沟通|已投递|已开聊/.test(text)) return { ok: false, reason: text };
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 7000 });
    await delay(1200);
    const blockerAfter = await this.detectPageBlocker(page);
    if (blockerAfter) return { ok: false, blocker: blockerAfter };
    const afterText = normalizeText(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    if (/今日沟通已达上限|沟通次数已用完|打招呼次数已达上限/.test(afterText)) {
      return { ok: false, blocker: "daily communication limit" };
    }
    return { ok: true };
  }

  async nextPage(page) {
    const next = page.locator(".options-pages a, .page a, .pagination a").filter({ hasText: /下一页|>/ }).last();
    if (!(await next.count())) return false;
    const disabled = await next.evaluate((node) => {
      const className = node.className || "";
      return /disabled|unable/.test(String(className)) || node.getAttribute("aria-disabled") === "true";
    }).catch(() => true);
    if (disabled) return false;
    await next.click({ timeout: 6000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    return true;
  }

  async block(runLog, blocker, page = null) {
    if (isLoginBlocker(blocker) && page && !page.isClosed()) {
      await this.openLoginPage(page);
    }
    await this.appendRun(runLog, `- Blocked: ${blocker}`);
    this.updateStatus({ state: "blocked", blocker, message: "Manual action required" });
    this.emitLog(`Blocked: ${blocker}`, "warn");
  }

  async appendRun(runLog, line) {
    await fs.appendFile(runLog, `${line}\n`, "utf8");
    this.emit("runLine", { line, at: nowIso() });
  }
}

function candidateKey(candidate) {
  return [candidate.company, candidate.title, candidate.salary, candidate.location].map((part) => normalizeText(part)).join("|");
}

function formatCandidate(candidate) {
  return [candidate.company, candidate.title, candidate.salary, candidate.location].map((part) => normalizeText(part || "-")).join(" | ");
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed|Browser has been closed|Target closed|Page closed|automation browser closed/i.test(
    String(error?.message || error || ""),
  );
}

function isLoginBlocker(blocker) {
  return /login|captcha|security|登录|扫码|验证码|安全验证/i.test(String(blocker || ""));
}
