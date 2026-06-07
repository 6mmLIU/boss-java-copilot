import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Chip,
  Drawer,
  Input,
  Modal,
  Spinner,
  Switch,
  Table,
  Tabs,
  TextArea,
  useOverlayState,
} from "@heroui/react";
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  Database,
  Eye,
  FileText,
  Filter,
  Gauge,
  ListFilter,
  Monitor,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  XCircle,
} from "lucide-react";

const API = "";
const tabItems = [
  { id: "run", label: "运行", icon: Play },
  { id: "filters", label: "筛选器", icon: SlidersHorizontal },
  { id: "candidates", label: "候选池", icon: BriefcaseBusiness },
  { id: "logs", label: "日志", icon: FileText },
  { id: "settings", label: "设置", icon: Settings },
];
const statusLabels = {
  idle: "空闲",
  preflight: "预检中",
  running: "运行中",
  stopping: "停止中",
  blocked: "需人工处理",
  error: "异常",
  done: "完成",
};
const experienceOptions = ["经验不限", "应届", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"];

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function shortNumber(value) {
  const num = Number(value || 0);
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function statusTone(state) {
  if (state === "running" || state === "preflight") return "info";
  if (state === "blocked" || state === "error") return "danger";
  if (state === "done") return "success";
  return "neutral";
}

function App() {
  const [activeTab, setActiveTab] = useState("run");
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [status, setStatus] = useState({ state: "idle", message: "Ready", applied: 0, screened: 0, skipped: 0 });
  const [logs, setLogs] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [selectedLog, setSelectedLog] = useState("");
  const [logPreview, setLogPreview] = useState("");
  const [liveLines, setLiveLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateStatus, setCandidateStatus] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [manualJob, setManualJob] = useState({
    company: "示例科技",
    title: "Java 后端开发工程师",
    salary: "15-25K",
    location: "上海",
    meta: "SpringBoot Redis MySQL 微服务 今日活跃",
    detailText: "负责支付、订单、对账等核心系统开发，要求 Java、Spring Cloud、MyBatis、Redis、RocketMQ。",
  });
  const [manualResult, setManualResult] = useState(null);

  const autoConfirm = useOverlayState();
  const drawerState = useOverlayState({
    isOpen: Boolean(selectedCandidate),
    onOpenChange: (isOpen) => {
      if (!isOpen) setSelectedCandidate(null);
    },
  });

  const isRunning = status.state === "running" || status.state === "preflight" || status.state === "stopping";
  const enabledCities = useMemo(() => (config?.cities || []).filter((city) => city.enabled !== false), [config]);
  const candidateCities = useMemo(() => {
    const cities = new Set();
    for (const item of candidates) {
      const city = String(item.location || "").split("·")[0].trim();
      if (city) cities.add(city);
    }
    return [...cities].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [candidates]);
  const filteredCandidates = useMemo(() => {
    const needle = candidateSearch.trim().toLowerCase();
    return candidates
      .filter((item) => (candidateStatus === "all" ? true : item.status === candidateStatus))
      .filter((item) => (cityFilter === "all" ? true : String(item.location || "").includes(cityFilter)))
      .filter((item) => {
        if (!needle) return true;
        return [item.company, item.title, item.salary, item.location, item.reason, item.query]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .slice(0, 240);
  }, [candidateSearch, candidateStatus, cityFilter, candidates]);
  const appliedTotal = useMemo(() => candidates.filter((item) => item.status === "applied").length, [candidates]);
  const skippedTotal = useMemo(() => candidates.filter((item) => item.status === "skipped").length, [candidates]);
  const latestLog = logs[0];

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(event.data);
      if (packet.type === "status") setStatus(packet.payload);
      if (packet.type === "log") pushLive(`${packet.payload.level.toUpperCase()} ${packet.payload.message}`);
      if (packet.type === "runLine") pushLive(packet.payload.line);
      if (packet.type === "candidate") pushLive(`候选: ${packet.payload.company || "-"} / ${packet.payload.title || "-"}`);
      if (packet.type === "applied") pushLive(`已投递: ${packet.payload.company || "-"} / ${packet.payload.title || "-"}`);
    });
    return () => socket.close();
  }, []);

  async function loadInitial() {
    setLoading(true);
    setError("");
    try {
      const [configPayload, platformPayload, statusPayload, candidatePayload] = await Promise.all([
        request("/api/config"),
        request("/api/platform"),
        request("/api/status"),
        request("/api/candidates"),
      ]);
      setConfig(configPayload.config);
      setDefaults(configPayload.defaults);
      setPlatform(platformPayload);
      setStatus(statusPayload.status);
      setLogs(candidatePayload.logs);
      setCandidates(candidatePayload.candidates);
      setSelectedLog(candidatePayload.logs?.[0]?.file || "");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshCandidates() {
    const payload = await request("/api/candidates");
    setLogs(payload.logs);
    setCandidates(payload.candidates);
    if (!selectedLog && payload.logs[0]) setSelectedLog(payload.logs[0].file);
  }

  function pushLive(line) {
    setLiveLines((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 80));
  }

  function updateConfig(patch) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  function updateCity(key, enabled) {
    updateConfig({
      cities: config.cities.map((city) => (city.key === key ? { ...city, enabled } : city)),
    });
  }

  function updateArray(name, next) {
    updateConfig({ [name]: next.filter(Boolean) });
  }

  async function saveConfig() {
    setBusy("save");
    setNotice("");
    setError("");
    try {
      const payload = await request("/api/config", { method: "POST", body: JSON.stringify({ config }) });
      setConfig(payload.config);
      setNotice("配置已保存");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function preflight() {
    await runAction("preflight", async () => request("/api/run/preflight", { method: "POST", body: JSON.stringify({ config }) }));
  }

  async function startRun(mode) {
    const nextConfig = { ...config, mode };
    setConfig(nextConfig);
    autoConfirm.close();
    await runAction(`start-${mode}`, async () =>
      request("/api/run/start", { method: "POST", body: JSON.stringify({ config: nextConfig }) }),
    );
  }

  async function stopRun() {
    await runAction("stop", async () => request("/api/run/stop", { method: "POST", body: JSON.stringify({ reason: "stopped from UI" }) }));
  }

  async function runAction(name, fn) {
    setBusy(name);
    setNotice("");
    setError("");
    try {
      const payload = await fn();
      if (payload.status) setStatus(payload.status);
      setNotice("命令已发送");
      window.setTimeout(refreshCandidates, 900);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function screenManualJob() {
    setBusy("manual-screen");
    setError("");
    try {
      const payload = await request("/api/screen", { method: "POST", body: JSON.stringify({ job: manualJob }) });
      setManualResult(payload.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function loadLog(file) {
    setSelectedLog(file);
    setBusy(`log-${file}`);
    try {
      const payload = await request(`/api/logs/${encodeURIComponent(file)}`);
      setLogPreview(payload.text);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function resetConfig() {
    if (defaults) setConfig(defaults);
  }

  if (loading || !config) {
    return (
      <main className="boot-screen">
        <Spinner size="lg" />
        <p>正在加载 BOSS Java Copilot...</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Bot size={22} />
          </div>
          <div>
            <p className="eyebrow">Local Java job workflow</p>
            <h1>BOSS Java Copilot</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <StatusPill state={status.state} />
          <Chip color="default" variant="secondary" size="sm">
            <Monitor size={14} /> {platform?.platform || "local"} / {platform?.node || "node"}
          </Chip>
          <Button variant="outline" size="sm" onPress={loadInitial} isDisabled={Boolean(busy)}>
            <RefreshCw size={15} />
            刷新
          </Button>
        </div>
      </header>

      {(notice || error || status.blocker) && (
        <section className={cx("notice-row", error || status.blocker ? "danger" : "success")}>
          {error || status.blocker ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{error || status.blocker || notice}</span>
        </section>
      )}

      <section className="kpi-grid">
        <KpiCard title="历史已投" value={appliedTotal} icon={Send} tone="green" detail={latestLog?.file || "读取本地 Markdown 日志"} />
        <KpiCard title="本轮目标" value={config.target} icon={Gauge} tone="blue" detail={`${enabledCities.length} 个城市 / ${config.queries.length} 组关键词`} />
        <KpiCard title="候选记录" value={candidates.length} icon={Database} tone="ink" detail={`${skippedTotal} 条跳过记录可复盘`} />
        <KpiCard title="运行状态" value={statusLabels[status.state] || status.state} icon={ShieldAlert} tone={statusTone(status.state)} detail={status.message || "Ready"} />
      </section>

      <Tabs selectedKey={activeTab} onSelectionChange={(key) => setActiveTab(String(key))} variant="secondary" className="workspace-tabs">
        <Tabs.List className="tabs-list" aria-label="工作区">
          {tabItems.map((item) => {
            const Icon = item.icon;
            return (
              <Tabs.Tab key={item.id} id={item.id} className="tabs-tab">
                <Icon size={15} />
                {item.label}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        <Tabs.Panel id="run" className="tab-panel">
          <RunPanel
            config={config}
            status={status}
            busy={busy}
            liveLines={liveLines}
            isRunning={isRunning}
            enabledCities={enabledCities}
            onConfig={updateConfig}
            onCity={updateCity}
            onSave={saveConfig}
            onPreflight={preflight}
            onStartReview={() => startRun("review")}
            onOpenAuto={autoConfirm.open}
            onStop={stopRun}
          />
        </Tabs.Panel>

        <Tabs.Panel id="filters" className="tab-panel">
          <FiltersPanel
            config={config}
            busy={busy}
            manualJob={manualJob}
            manualResult={manualResult}
            onConfig={updateConfig}
            onArray={updateArray}
            onManualJob={setManualJob}
            onScreen={screenManualJob}
            onReset={resetConfig}
            onSave={saveConfig}
          />
        </Tabs.Panel>

        <Tabs.Panel id="candidates" className="tab-panel">
          <CandidatesPanel
            candidates={filteredCandidates}
            total={candidates.length}
            search={candidateSearch}
            status={candidateStatus}
            city={cityFilter}
            cities={candidateCities}
            onSearch={setCandidateSearch}
            onStatus={setCandidateStatus}
            onCity={setCityFilter}
            onSelect={setSelectedCandidate}
            onRefresh={refreshCandidates}
          />
        </Tabs.Panel>

        <Tabs.Panel id="logs" className="tab-panel">
          <LogsPanel
            logs={logs}
            selectedLog={selectedLog}
            logPreview={logPreview}
            busy={busy}
            onLoadLog={loadLog}
            onRefresh={refreshCandidates}
          />
        </Tabs.Panel>

        <Tabs.Panel id="settings" className="tab-panel">
          <SettingsPanel config={config} platform={platform} busy={busy} onConfig={updateConfig} onSave={saveConfig} />
        </Tabs.Panel>
      </Tabs>

      <Modal state={autoConfirm}>
        <Modal.Backdrop variant="blur">
          <Modal.Container placement="center" size="md">
            <Modal.Dialog className="confirm-dialog">
              <Modal.Header>
                <Modal.Icon>
                  <ShieldAlert size={20} />
                </Modal.Icon>
                <Modal.Heading>确认启动自动投递</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p>
                  自动模式会在筛选通过后点击“立即沟通”。如果页面出现登录、二维码、验证码、安全验证或沟通上限，runner 会停止并等待你处理。
                </p>
                <div className="confirm-metrics">
                  <span>目标 {config.target}</span>
                  <span>{enabledCities.length} 城市</span>
                  <span>{config.minSalaryK}K 起</span>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="outline" onPress={autoConfirm.close}>
                  取消
                </Button>
                <Button variant="danger" onPress={() => startRun("auto")} isDisabled={isRunning || busy === "start-auto"}>
                  <Send size={16} />
                  启动自动投递
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Drawer state={drawerState}>
        <Drawer.Backdrop variant="blur">
          <Drawer.Content placement="right">
            <Drawer.Dialog className="candidate-drawer">
              <Drawer.Header>
                <Drawer.Heading>{selectedCandidate?.title || "候选详情"}</Drawer.Heading>
                <Drawer.CloseTrigger aria-label="关闭" />
              </Drawer.Header>
              <Drawer.Body>
                {selectedCandidate && <CandidateDetail candidate={selectedCandidate} />}
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
    </main>
  );
}

function StatusPill({ state }) {
  const tone = statusTone(state);
  return (
    <Chip className={cx("status-pill", `tone-${tone}`)} variant="secondary" size="sm">
      <span className="status-dot" />
      {statusLabels[state] || state}
    </Chip>
  );
}

function KpiCard({ title, value, icon: Icon, detail, tone }) {
  return (
    <Card className={cx("kpi-card", `tone-${tone}`)}>
      <Card.Header>
        <div className="kpi-icon">
          <Icon size={18} />
        </div>
        <span>{title}</span>
      </Card.Header>
      <Card.Content>
        <strong className="t-number-pop" key={value}>
          {typeof value === "number" ? shortNumber(value) : value}
        </strong>
        <p>{detail}</p>
      </Card.Content>
    </Card>
  );
}

function RunPanel({
  config,
  status,
  busy,
  liveLines,
  isRunning,
  enabledCities,
  onConfig,
  onCity,
  onSave,
  onPreflight,
  onStartReview,
  onOpenAuto,
  onStop,
}) {
  return (
    <div className="run-layout">
      <Card className="command-card">
        <Card.Header>
          <div>
            <Card.Title>运行控制</Card.Title>
            <Card.Description>先预检登录态，再选择复审模式或自动投递模式。</Card.Description>
          </div>
          <StatusPill state={status.state} />
        </Card.Header>
        <Card.Content>
          <div className="control-grid">
            <Field label="目标数量">
              <Input
                type="number"
                min="1"
                max="500"
                value={String(config.target)}
                onChange={(event) => onConfig({ target: Number(event.target.value) })}
                fullWidth
              />
            </Field>
            <Field label="最低薪资 K">
              <Input
                type="number"
                min="1"
                max="80"
                value={String(config.minSalaryK)}
                onChange={(event) => onConfig({ minSalaryK: Number(event.target.value) })}
                fullWidth
              />
            </Field>
            <Field label="单关键词页数">
              <Input
                type="number"
                min="1"
                max="8"
                value={String(config.maxPagesPerQuery)}
                onChange={(event) => onConfig({ maxPagesPerQuery: Number(event.target.value) })}
                fullWidth
              />
            </Field>
            <Field label="动作间隔 ms">
              <Input
                type="number"
                min="250"
                step="50"
                value={String(config.delayMs)}
                onChange={(event) => onConfig({ delayMs: Number(event.target.value) })}
                fullWidth
              />
            </Field>
          </div>

          <div className="mode-strip" role="group" aria-label="运行模式">
            <button
              className={cx("mode-button", config.mode === "review" && "is-active")}
              type="button"
              onClick={() => onConfig({ mode: "review" })}
            >
              <Eye size={16} />
              <span>复审收集</span>
            </button>
            <button
              className={cx("mode-button", config.mode === "auto" && "is-active")}
              type="button"
              onClick={() => onConfig({ mode: "auto" })}
            >
              <Send size={16} />
              <span>自动投递</span>
            </button>
          </div>

          <div className="city-board">
            <div className="section-heading">
              <span>城市轮换</span>
              <small>{enabledCities.length} 个已启用，杭州默认关闭</small>
            </div>
            <div className="chip-grid">
              {config.cities.map((city) => (
                <button
                  type="button"
                  key={city.key}
                  className={cx("city-chip", city.enabled !== false && "is-on")}
                  onClick={() => onCity(city.key, city.enabled === false)}
                >
                  {city.label}
                </button>
              ))}
            </div>
          </div>

          <div className="command-row">
            <Button variant="outline" onPress={onSave} isDisabled={Boolean(busy)}>
              {busy === "save" ? <Spinner size="sm" /> : <Save size={16} />}
              保存配置
            </Button>
            <Button variant="secondary" onPress={onPreflight} isDisabled={isRunning || Boolean(busy)}>
              {busy === "preflight" ? <Spinner size="sm" /> : <BadgeCheck size={16} />}
              预检登录
            </Button>
            <Button variant="primary" onPress={onStartReview} isDisabled={isRunning || Boolean(busy)}>
              {busy === "start-review" ? <Spinner size="sm" /> : <Eye size={16} />}
              开始复审
            </Button>
            <Button variant="danger-soft" onPress={onOpenAuto} isDisabled={isRunning || Boolean(busy)}>
              <Send size={16} />
              自动投递
            </Button>
            <Button variant="ghost" onPress={onStop} isDisabled={!isRunning || busy === "stop"}>
              {busy === "stop" ? <Spinner size="sm" /> : <Square size={15} />}
              停止
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card className="live-card">
        <Card.Header>
          <div>
            <Card.Title>实时状态</Card.Title>
            <Card.Description>{status.currentCity || "等待任务"} {status.currentQuery ? ` / ${status.currentQuery}` : ""}</Card.Description>
          </div>
          <Badge>
            <Chip size="sm" color="default" variant="secondary">
              {status.applied || 0}/{config.target}
            </Chip>
          </Badge>
        </Card.Header>
        <Card.Content>
          <div className="progress-rail">
            <span style={{ width: `${Math.min(100, ((status.applied || 0) / Math.max(1, config.target)) * 100)}%` }} />
          </div>
          <div className="live-console" aria-live="polite">
            {liveLines.length ? liveLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>) : <p>还没有运行事件。</p>}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

function FiltersPanel({ config, busy, manualJob, manualResult, onConfig, onArray, onManualJob, onScreen, onReset, onSave }) {
  return (
    <div className="filters-layout">
      <Card className="filter-card">
        <Card.Header>
          <div>
            <Card.Title>硬性筛选</Card.Title>
            <Card.Description>这些规则会直接影响自动化 runner 的跳过/通过判断。</Card.Description>
          </div>
          <Button variant="outline" size="sm" onPress={onReset}>
            恢复默认
          </Button>
        </Card.Header>
        <Card.Content className="stack">
          <div className="toggle-line">
            <div>
              <strong>优先好厂/好业务</strong>
              <p>开启后会更偏向大厂、平台、金融/支付/供应链等业务质量信号。</p>
            </div>
            <Switch isSelected={config.qualityMode === "better"} onChange={(value) => onConfig({ qualityMode: value ? "better" : "standard" })}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch>
          </div>
          <ChoiceChips
            label="可接受经验"
            items={experienceOptions}
            selected={config.allowedExperience}
            onToggle={(item) =>
              onArray(
                "allowedExperience",
                config.allowedExperience.includes(item)
                  ? config.allowedExperience.filter((value) => value !== item)
                  : [...config.allowedExperience, item],
              )
            }
          />
          <KeywordEditor label="硬排除词" items={config.hardExclusions} onChange={(next) => onArray("hardExclusions", next)} />
          <KeywordEditor label="外包/驻场信号" items={config.outsourcingSignals} onChange={(next) => onArray("outsourcingSignals", next)} />
          <KeywordEditor label="优先技术栈" items={config.preferredTech} onChange={(next) => onArray("preferredTech", next)} />
          <KeywordEditor label="优先业务域" items={config.preferredDomains} onChange={(next) => onArray("preferredDomains", next)} />
          <div className="command-row compact">
            <Button variant="primary" onPress={onSave} isDisabled={Boolean(busy)}>
              {busy === "save" ? <Spinner size="sm" /> : <Save size={16} />}
              保存筛选器
            </Button>
          </div>
        </Card.Content>
      </Card>

      <Card className="manual-card">
        <Card.Header>
          <div>
            <Card.Title>手动评估</Card.Title>
            <Card.Description>粘贴岗位信息，立即用同一套规则打分。</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="stack">
          <Field label="公司">
            <Input value={manualJob.company} onChange={(event) => onManualJob({ ...manualJob, company: event.target.value })} fullWidth />
          </Field>
          <Field label="岗位">
            <Input value={manualJob.title} onChange={(event) => onManualJob({ ...manualJob, title: event.target.value })} fullWidth />
          </Field>
          <div className="two-col">
            <Field label="薪资">
              <Input value={manualJob.salary} onChange={(event) => onManualJob({ ...manualJob, salary: event.target.value })} fullWidth />
            </Field>
            <Field label="城市">
              <Input value={manualJob.location} onChange={(event) => onManualJob({ ...manualJob, location: event.target.value })} fullWidth />
            </Field>
          </div>
          <Field label="卡片标签">
            <Input value={manualJob.meta} onChange={(event) => onManualJob({ ...manualJob, meta: event.target.value })} fullWidth />
          </Field>
          <Field label="详情文本">
            <TextArea
              value={manualJob.detailText}
              onChange={(event) => onManualJob({ ...manualJob, detailText: event.target.value })}
              fullWidth
              rows={6}
            />
          </Field>
          <Button variant="primary" onPress={onScreen} isDisabled={busy === "manual-screen"}>
            {busy === "manual-screen" ? <Spinner size="sm" /> : <Filter size={16} />}
            评估岗位
          </Button>
          {manualResult && <ScreenResult result={manualResult} />}
        </Card.Content>
      </Card>
    </div>
  );
}

function CandidatesPanel({ candidates, total, search, status, city, cities, onSearch, onStatus, onCity, onSelect, onRefresh }) {
  return (
    <Card className="table-card">
      <Card.Header>
        <div>
          <Card.Title>候选池</Card.Title>
          <Card.Description>来自历史投递日志和当前运行事件，最多展示前 240 条筛选结果。</Card.Description>
        </div>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          <RefreshCw size={15} />
          重读日志
        </Button>
      </Card.Header>
      <Card.Content>
        <div className="table-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索公司、岗位、原因" />
          </div>
          <Segmented value={status} onChange={onStatus} options={[["all", "全部"], ["applied", "已投"], ["skipped", "跳过"]]} />
          <select value={city} onChange={(event) => onCity(event.target.value)}>
            <option value="all">全部城市</option>
            {cities.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="table-meta">
          <span>显示 {candidates.length} / {total}</span>
        </div>
        <Table variant="secondary" className="candidate-table">
          <Table.ScrollContainer>
            <Table.Content aria-label="候选岗位表">
              <Table.Header>
                <Table.Column isRowHeader>公司</Table.Column>
                <Table.Column>岗位</Table.Column>
                <Table.Column>薪资</Table.Column>
                <Table.Column>城市</Table.Column>
                <Table.Column>状态</Table.Column>
                <Table.Column>原因</Table.Column>
                <Table.Column>操作</Table.Column>
              </Table.Header>
              <Table.Body items={candidates} renderEmptyState={() => <div className="empty-state">暂无候选记录</div>}>
                {(item) => (
                  <Table.Row id={item.id}>
                    <Table.Cell>{item.company}</Table.Cell>
                    <Table.Cell>{item.title}</Table.Cell>
                    <Table.Cell>{item.salary}</Table.Cell>
                    <Table.Cell>{item.location}</Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" color={item.status === "applied" ? "success" : "default"} variant="secondary">
                        {item.status === "applied" ? "已投" : "跳过"}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="reason-cell">{item.reason}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <Button size="sm" variant="ghost" isIconOnly aria-label="查看详情" onPress={() => onSelect(item)}>
                        <Eye size={15} />
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card.Content>
    </Card>
  );
}

function LogsPanel({ logs, selectedLog, logPreview, busy, onLoadLog, onRefresh }) {
  return (
    <div className="logs-layout">
      <Card className="logs-list">
        <Card.Header>
          <div>
            <Card.Title>本地日志</Card.Title>
            <Card.Description>读取根目录下的 BOSS Java Markdown 投递日志。</Card.Description>
          </div>
          <Button variant="outline" size="sm" onPress={onRefresh}>
            <RefreshCw size={15} />
          </Button>
        </Card.Header>
        <Card.Content className="log-list-content">
          {logs.map((log) => (
            <button
              key={log.file}
              type="button"
              className={cx("log-item", selectedLog === log.file && "is-active")}
              onClick={() => onLoadLog(log.file)}
            >
              <FileText size={15} />
              <span>{log.file}</span>
              <small>{log.applied || 0} 投 / {log.skipped || 0} 跳</small>
            </button>
          ))}
        </Card.Content>
      </Card>
      <Card className="log-preview">
        <Card.Header>
          <div>
            <Card.Title>{selectedLog || "选择日志"}</Card.Title>
            <Card.Description>原始 Markdown 预览。</Card.Description>
          </div>
        </Card.Header>
        <Card.Content>
          {busy.startsWith("log-") ? <Spinner /> : <pre>{logPreview || "点击左侧日志查看内容。"}</pre>}
        </Card.Content>
      </Card>
    </div>
  );
}

function SettingsPanel({ config, platform, busy, onConfig, onSave }) {
  return (
    <Card className="settings-card">
      <Card.Header>
        <div>
          <Card.Title>环境与安全</Card.Title>
          <Card.Description>跨平台运行设置；Mac 和 Windows 都通过 Playwright 控制本地 Chrome/Chromium。</Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="settings-grid">
        <Field label="浏览器通道">
          <Segmented value={config.browserChannel} onChange={(value) => onConfig({ browserChannel: value })} options={[["chrome", "Chrome"], ["chromium", "Chromium"]]} />
        </Field>
        <Field label="浏览器 Profile 目录">
          <Input value={config.profileDir || ""} onChange={(event) => onConfig({ profileDir: event.target.value })} fullWidth />
        </Field>
        <div className="toggle-line">
          <div>
            <strong>无头模式</strong>
            <p>投递流程建议保持关闭，方便你处理登录、二维码和安全提示。</p>
          </div>
          <Switch isSelected={Boolean(config.headless)} onChange={(value) => onConfig({ headless: value })}>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch>
        </div>
        <div className="system-card">
          <LaptopLine label="系统" value={`${platform?.platform || "-"} / ${platform?.arch || "-"}`} />
          <LaptopLine label="Node" value={platform?.node || "-"} />
          <LaptopLine label="工作目录" value={platform?.cwd || "-"} />
        </div>
        <div className="safety-card">
          <ShieldAlert size={18} />
          <div>
            <strong>硬停止规则</strong>
            <p>检测到登录、扫码、验证码、安全验证、沟通上限时停止；不会尝试绕过 BOSS 的安全机制。</p>
          </div>
        </div>
        <Button variant="primary" onPress={onSave} isDisabled={Boolean(busy)}>
          {busy === "save" ? <Spinner size="sm" /> : <Save size={16} />}
          保存设置
        </Button>
      </Card.Content>
    </Card>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ChoiceChips({ label, items, selected, onToggle }) {
  return (
    <div className="choice-block">
      <span>{label}</span>
      <div className="chip-grid">
        {items.map((item) => (
          <button key={item} type="button" className={cx("city-chip", selected.includes(item) && "is-on")} onClick={() => onToggle(item)}>
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}

function KeywordEditor({ label, items, onChange }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="keyword-editor">
      <div className="section-heading">
        <span>{label}</span>
        <small>{items.length} 条</small>
      </div>
      <div className="keyword-input">
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="添加关键词" fullWidth />
        <Button
          variant="outline"
          onPress={() => {
            if (!draft.trim()) return;
            onChange([...items, draft.trim()]);
            setDraft("");
          }}
        >
          添加
        </Button>
      </div>
      <div className="keyword-cloud">
        {items.map((item, index) => (
          <button key={`${item}-${index}`} type="button" onClick={() => onChange(items.filter((_, i) => i !== index))}>
            {item}
            <XCircle size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="segmented">
      {options.map(([id, label]) => (
        <button key={id} type="button" className={value === id ? "is-active" : ""} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ScreenResult({ result }) {
  return (
    <div className={cx("screen-result", result.pass ? "pass" : "fail")}>
      <div className="score-ring">{result.score}</div>
      <div>
        <strong>{result.pass ? "建议进入投递队列" : "建议跳过"}</strong>
        <p>{result.reason}</p>
        {result.warnings?.length ? <small>{result.warnings.join(" / ")}</small> : null}
      </div>
    </div>
  );
}

function CandidateDetail({ candidate }) {
  return (
    <div className="candidate-detail">
      <div className="detail-hero">
        <Building2 size={20} />
        <div>
          <strong>{candidate.company}</strong>
          <p>{candidate.salary} / {candidate.location}</p>
        </div>
      </div>
      <InfoLine label="状态" value={candidate.status === "applied" ? "已投递" : "跳过"} />
      <InfoLine label="来源" value={candidate.source || "-"} />
      <InfoLine label="查询" value={candidate.query || "-"} />
      <InfoLine label="原因" value={candidate.reason || "-"} />
    </div>
  );
}

function InfoLine({ label, value }) {
  return (
    <div className="info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LaptopLine({ label, value }) {
  return (
    <div className="laptop-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
