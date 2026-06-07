# BOSS Java Copilot

[中文说明](./README.zh-CN.md)

BOSS Java Copilot is a local-first job screening and application workflow for Java developer roles on BOSS Zhipin. It combines a HeroUI-based operations console, a local Express API, WebSocket runtime updates, reusable screening rules, historical Markdown log parsing, and a cross-platform Playwright runner for macOS and Windows.

The project is designed as a practical workbench rather than a marketing page: configure the search strategy, preflight browser login, run review mode, inspect candidates, tune filters, and only then optionally start guarded auto-apply mode.

## Highlights

- Cross-platform local automation with Playwright persistent browser profiles.
- Works on macOS and Windows with the same Node.js workflow.
- HeroUI v3 + React 19 + Tailwind CSS v4 frontend.
- Structured tabs for Run, Filters, Candidate Pool, Logs, and Settings.
- Review mode for collecting and screening candidates without clicking the apply/chat button.
- Guarded auto-apply mode with a confirmation dialog.
- Hard-stop detection for login prompts, QR code login, CAPTCHA, security checks, and daily communication limits.
- Local candidate screening engine shared by the frontend, API, and runner.
- Historical Markdown log parsing for audit and deduplication.
- Configurable city rotation, keyword groups, salary floor, experience bands, company quality mode, hard exclusions, outsourcing signals, preferred tech, and preferred business domains.

## Responsible Use

This project does not bypass login, CAPTCHA, security verification, platform rate limits, or communication limits. When those states are detected, the runner stops and waits for manual action.

Use this tool responsibly and review the target platform's terms, job-application etiquette, and your own resume/application quality before running automation. The default workflow encourages review mode first.

## Tech Stack

- React 19
- Vite 7
- HeroUI v3
- Tailwind CSS v4
- Express 5
- WebSocket via `ws`
- Playwright
- Lucide React icons

## Project Structure

```text
.
├── src/
│   ├── App.jsx              # HeroUI workbench UI
│   ├── main.jsx             # React entry
│   └── styles.css           # Layout, theme, and custom workflow motion
├── server/
│   ├── index.js             # Express API + WebSocket server
│   ├── automation/
│   │   └── bossRunner.js    # Cross-platform Playwright runner
│   └── lib/
│       ├── defaults.js      # Default cities, queries, filters
│       └── rules.js         # Shared screening and log parsing rules
├── docs/
│   └── design-notes.md      # UI and interaction design notes
├── scripts/
│   └── boss-java-apply.mjs  # Legacy macOS AppleScript workflow
├── index.html
├── package.json
└── vite.config.js
```

## Requirements

- Node.js 22+
- npm
- Google Chrome or Playwright Chromium

HeroUI v3 requires React 19+ and Tailwind CSS v4. The app imports styles in the required order:

```css
@import "tailwindcss";
@import "@heroui/styles";
```

## Installation

```bash
npm install
```

If Playwright cannot find a browser, install Chromium:

```bash
npx playwright install chromium
```

## Development

Start the local API:

```bash
npm start
```

Start the Vite frontend:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5177/
```

Default ports:

- Frontend: `5177`
- API: `8797`

To use a different API port:

```bash
PORT=8801 npm start
API_PORT=8801 npm run dev
```

Windows PowerShell:

```powershell
$env:PORT="8801"; npm start
$env:API_PORT="8801"; npm run dev
```

## Verification

```bash
npm run check
```

This runs Node syntax checks and a production Vite build.

## Workflow

1. Open the Run tab and configure target count, salary floor, page limit, delay, cities, and mode.
2. Save the configuration.
3. Click Preflight Login to open the BOSS page in a local browser profile.
4. Handle login, QR code, or security prompts manually if they appear.
5. Start Review Mode first to collect and screen candidates without applying.
6. Inspect the Candidate Pool and Logs tabs.
7. Tune filters if too many unsuitable jobs pass or too many good jobs are skipped.
8. Start Auto Apply only after confirming the rules are correct.

## Filtering Model

The screening engine checks:

- hard exclusions such as internships, management trainee roles, short-term projects, leadership-heavy titles, degree mismatch, and non-development roles;
- outsourcing and client-site signals;
- salary floor;
- experience bands;
- Java/backend relevance;
- Java stack signals such as Spring, Spring Boot, Spring Cloud, MyBatis, Redis, RocketMQ, Kafka, Dubbo, Nacos, JVM, Docker, and Kubernetes;
- domain fit such as payment, reconciliation, funds, banking, trading, order systems, ERP, supply chain, SaaS, IoT, cloud platforms, and middleware;
- company quality and business quality signals in better-company mode;
- HR freshness signals when visible.

## Local Data and Privacy

The repository intentionally ignores:

- real job-application Markdown logs;
- screenshots;
- local browser profiles;
- runtime data under `data/`;
- build output under `dist/`;
- dependencies under `node_modules/`;
- environment files such as `.env`.

Those files may exist locally during real usage but should not be committed to a public repository.

## Notes

- The current runner is intentionally conservative around security prompts.
- The legacy `scripts/boss-java-apply.mjs` script is macOS-specific and kept for reference. The main project path is the cross-platform Playwright runner in `server/automation/bossRunner.js`.
- The production bundle may show a chunk-size warning because HeroUI and React Aria are included in the first app shell. This does not block usage; future work can split tabs into dynamic chunks.
