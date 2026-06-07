# BOSS Java Copilot

[English README](./README.md)

BOSS Java Copilot 是一个本地优先的 Java 岗位筛选与投递工作台，面向 BOSS 直聘上的 Java 后端岗位搜索、筛选、复盘和受控自动化。项目由 HeroUI 前端控制台、本地 Express API、WebSocket 实时状态、统一筛选规则、历史 Markdown 日志解析，以及 macOS/Windows 通用的 Playwright runner 组成。

它不是营销页，而是一个实际可用的工作流工具：配置搜索策略、预检浏览器登录、先跑复审模式、查看候选池、调筛选器，最后再选择是否进入带二次确认的自动投递模式。

## 核心功能

- 使用 Playwright 持久化浏览器 Profile，macOS 和 Windows 同一套运行方式。
- HeroUI v3 + React 19 + Tailwind CSS v4 前端界面。
- 运行、筛选器、候选池、日志、设置五个工作区。
- 复审模式：只收集和筛选岗位，不点击“立即沟通”。
- 自动投递模式：筛选通过后执行投递动作，但启动前必须二次确认。
- 登录、二维码、验证码、安全验证、沟通上限等状态会触发硬停止。
- 前端手动评估、后端 API、自动化 runner 共用同一套筛选规则。
- 可读取历史 Markdown 投递日志，做候选池展示、审计和去重。
- 可配置城市轮换、关键词、最低薪资、经验范围、好厂优先、硬排除词、外包信号、优先技术栈和优先业务域。

## 使用边界

本项目不会绕过登录、验证码、安全验证、平台限制或沟通上限。检测到这些状态时，runner 会停止并等待人工处理。

请负责任地使用这个工具。建议先用复审模式确认岗位质量、筛选规则和简历匹配度，再考虑自动投递。

## 技术栈

- React 19
- Vite 7
- HeroUI v3
- Tailwind CSS v4
- Express 5
- `ws` WebSocket
- Playwright
- Lucide React 图标

## 目录结构

```text
.
├── src/
│   ├── App.jsx              # HeroUI 工作台界面
│   ├── main.jsx             # React 入口
│   └── styles.css           # 布局、主题和工作流动效
├── server/
│   ├── index.js             # Express API + WebSocket 服务
│   ├── automation/
│   │   └── bossRunner.js    # 跨平台 Playwright runner
│   └── lib/
│       ├── defaults.js      # 默认城市、关键词、筛选器
│       └── rules.js         # 统一筛选与日志解析规则
├── docs/
│   └── design-notes.md      # 前端设计、按钮布局、动效说明
├── scripts/
│   └── boss-java-apply.mjs  # 旧版 macOS AppleScript 流程
├── index.html
├── package.json
└── vite.config.js
```

## 环境要求

- Node.js 22+
- npm
- Google Chrome 或 Playwright Chromium

HeroUI v3 要求 React 19+ 和 Tailwind CSS v4。本项目按官方要求导入样式：

```css
@import "tailwindcss";
@import "@heroui/styles";
```

## 安装

```bash
npm install
```

如果 Playwright 找不到浏览器，可以安装 Chromium：

```bash
npx playwright install chromium
```

## 开发运行

启动本地 API：

```bash
npm start
```

启动前端：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5177/
```

默认端口：

- 前端：`5177`
- API：`8797`

如果要改 API 端口：

```bash
PORT=8801 npm start
API_PORT=8801 npm run dev
```

Windows PowerShell：

```powershell
$env:PORT="8801"; npm start
$env:API_PORT="8801"; npm run dev
```

## 检查与构建

```bash
npm run check
```

该命令会执行 Node 语法检查和 Vite 生产构建。

## 推荐流程

1. 打开“运行”页，设置目标数量、最低薪资、页数、动作间隔、城市和模式。
2. 点击保存配置。
3. 点击“预检登录”，用本地浏览器 Profile 打开 BOSS 页面。
4. 如果出现登录、二维码或安全验证，人工处理。
5. 先启动“复审模式”，收集和筛选候选岗位，不投递。
6. 在“候选池”和“日志”里查看已投、跳过和原因。
7. 如果跳过或通过不符合预期，到“筛选器”页调整规则。
8. 确认规则可靠后，再通过二次确认启动“自动投递”。

## 筛选模型

筛选器会检查：

- 实习、管培、短期项目、管理岗、学历不匹配、非研发等硬排除项；
- 外包、驻场、外派、客户现场等信号；
- 最低薪资；
- 经验范围；
- Java/后端相关性；
- Spring、Spring Boot、Spring Cloud、MyBatis、Redis、RocketMQ、Kafka、Dubbo、Nacos、JVM、Docker、Kubernetes 等技术栈；
- 支付、清结算、资金、银行、交易、订单、ERP、供应链、SaaS、物联网、云平台、中间件等业务域；
- 好厂优先模式下的公司质量和业务质量；
- 页面可见的 HR 活跃度。

## 本地数据与隐私

公开仓库会忽略以下本地文件：

- 真实投递 Markdown 日志；
- 截图；
- 本地浏览器 Profile；
- `data/` 下的运行数据；
- `dist/` 构建产物；
- `node_modules/` 依赖目录；
- `.env` 等环境文件。

这些文件可以在本地真实使用时生成，但不应该提交到公开仓库。

## 说明

- 当前 runner 对安全提示保持保守，不尝试绕过。
- `scripts/boss-java-apply.mjs` 是旧版 macOS AppleScript 参考流程；主路径是 `server/automation/bossRunner.js` 里的跨平台 Playwright runner。
- 生产构建可能提示首包 chunk 偏大，这是 HeroUI 和 React Aria 进入首屏包导致，不影响使用；后续可以按 Tab 做动态拆包。
