import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BossRunner } from "./automation/bossRunner.js";
import { defaultConfig } from "./lib/defaults.js";
import { listLogFiles, parseLogText, readAllLogCandidates, screenJob } from "./lib/rules.js";

const rootDir = process.cwd();
const dataDir = path.join(rootDir, "data");
const configPath = path.join(dataDir, "config.json");
const port = Number(process.env.PORT || 8797);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const runner = new BossRunner({ rootDir });
const sockets = new Set();

app.use(express.json({ limit: "1mb" }));

function sendJson(res, fn) {
  Promise.resolve()
    .then(fn)
    .then((data) => res.json(data))
    .catch((error) => {
      console.error(error);
      res.status(500).json({ ok: false, error: error.message });
    });
}

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  }
}

async function readConfig() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    return mergeConfig(saved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return mergeConfig({});
  }
}

async function writeConfig(config) {
  await fs.mkdir(dataDir, { recursive: true });
  const merged = mergeConfig(config);
  await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

function mergeConfig(config = {}) {
  return {
    ...defaultConfig,
    ...config,
    cities: Array.isArray(config.cities) ? config.cities : defaultConfig.cities,
    queries: Array.isArray(config.queries) ? config.queries : defaultConfig.queries,
    hardExclusions: Array.isArray(config.hardExclusions) ? config.hardExclusions : defaultConfig.hardExclusions,
    outsourcingSignals: Array.isArray(config.outsourcingSignals) ? config.outsourcingSignals : defaultConfig.outsourcingSignals,
    preferredTech: Array.isArray(config.preferredTech) ? config.preferredTech : defaultConfig.preferredTech,
    preferredDomains: Array.isArray(config.preferredDomains) ? config.preferredDomains : defaultConfig.preferredDomains,
    allowedExperience: Array.isArray(config.allowedExperience) ? config.allowedExperience : defaultConfig.allowedExperience,
  };
}

runner.on("status", (payload) => broadcast("status", payload));
runner.on("log", (payload) => broadcast("log", payload));
runner.on("runLine", (payload) => broadcast("runLine", payload));
runner.on("candidate", (payload) => broadcast("candidate", payload));
runner.on("applied", (payload) => broadcast("applied", payload));

wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "status", payload: runner.getStatus() }));
  socket.on("close", () => sockets.delete(socket));
});

app.get("/api/platform", (req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: os.hostname(),
    chromeChannel: "chrome",
    cwd: rootDir,
  });
});

app.get("/api/config", (req, res) => sendJson(res, async () => ({ ok: true, config: await readConfig(), defaults: defaultConfig })));

app.post("/api/config", (req, res) =>
  sendJson(res, async () => {
    const config = await writeConfig(req.body?.config || req.body || {});
    broadcast("config", config);
    return { ok: true, config };
  }),
);

app.get("/api/status", (req, res) => res.json({ ok: true, status: runner.getStatus() }));

app.get("/api/logs", (req, res) =>
  sendJson(res, async () => {
    const logs = await listLogFiles(rootDir);
    return { ok: true, logs };
  }),
);

app.get("/api/logs/:file", (req, res) =>
  sendJson(res, async () => {
    const requested = path.basename(req.params.file);
    const logs = await listLogFiles(rootDir);
    const found = logs.find((log) => log.file === requested);
    if (!found) {
      const error = new Error("Log not found");
      error.status = 404;
      throw error;
    }
    const text = await fs.readFile(found.path, "utf8");
    return { ok: true, file: requested, text, parsed: parseLogText(text, requested) };
  }),
);

app.get("/api/candidates", (req, res) =>
  sendJson(res, async () => {
    const { logs, candidates } = await readAllLogCandidates(rootDir);
    return { ok: true, logs, candidates };
  }),
);

app.post("/api/screen", (req, res) =>
  sendJson(res, async () => {
    const config = await readConfig();
    const result = screenJob(req.body?.job || req.body || {}, config);
    return { ok: true, result };
  }),
);

app.post("/api/run/preflight", (req, res) =>
  sendJson(res, async () => {
    const config = mergeConfig(req.body?.config || (await readConfig()));
    const result = await runner.preflight(config);
    return { ok: true, result, status: runner.getStatus() };
  }),
);

app.post("/api/browser/login", (req, res) =>
  sendJson(res, async () => {
    const config = mergeConfig(req.body?.config || (await readConfig()));
    const result = await runner.openLogin(config);
    return { ok: true, result, status: runner.getStatus() };
  }),
);

app.post("/api/browser/check-login", (req, res) =>
  sendJson(res, async () => {
    const config = mergeConfig(req.body?.config || (await readConfig()));
    const result = await runner.checkLogin(config, {
      allowNavigation: Boolean(req.body?.strict),
      reopenLoginOnBlank: Boolean(req.body?.reopen),
      announce: true,
    });
    return { ok: true, result, status: runner.getStatus() };
  }),
);

app.post("/api/run/start", (req, res) =>
  sendJson(res, async () => {
    const base = await readConfig();
    const config = mergeConfig({ ...base, ...(req.body?.config || {}) });
    await writeConfig(config);
    const status = await runner.start(config);
    return { ok: true, status };
  }),
);

app.post("/api/run/stop", (req, res) =>
  sendJson(res, async () => {
    const status = await runner.stop(req.body?.reason || "stopped by user");
    return { ok: true, status };
  }),
);

app.post("/api/browser/close", (req, res) =>
  sendJson(res, async () => {
    await runner.closeBrowser();
    return { ok: true, status: runner.getStatus() };
  }),
);

const distDir = path.join(rootDir, "dist");
app.use(express.static(distDir));
app.get(/.*/, async (req, res, next) => {
  try {
    await fs.access(path.join(distDir, "index.html"));
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    next();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`BOSS Java Copilot API listening on http://127.0.0.1:${port}`);
});
