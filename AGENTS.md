# AGENTS.md — rw_jarvis

This file documents the Jarvis voice-assistant application deployment across
three Docker containers in the `rw_mesh` WireGuard mesh WAN infrastructure.

> **Code source of truth: THIS repository** (`kirks2003/rw_jarvis`), app at
> the repo root. Since 2026-10-26 the app no longer lives in
> `kirks2003/rwnix-infra` (the `jarvis/` directory was removed there).
> The deployed copies on the hosts are **not** git repos — they are backed up
> and rebuilt from this repo.
>
> **Repo move (2026-10-26):** the newest deployed code (vm104 host tree,
> 2026-10-24 frontend + 2026-10-25 backend) was imported into this repo.
> During the audit it turned out the 2026-10-25 targeted file deploy had
> overwritten the 2026-10-23/24 `server.js` (which carried the `github-ro`
> MCP, ElevenLabs voice provider and persona-memory wiring, never committed
> to git). This repo's `server.js` is the **union**: the 2026-10-24 backup
> (`server.js.bak-20261024T085950Z` on vm104) plus the 2026-10-25
> `normalize-external-args.cjs` fix. The test suite was updated to the
> documented 2026-10-23 behavior (thinking phrase `Let me think.` /
> `Lass mich kurz nachdenken.`, greeting `Yes <name>` / `Ja <name>` without
> punctuation, MCP switches on by default, wake-word stop disarms).

---

## 1. Deployment overview

Three private Jarvis instances (plus one public a1-jarvis clone on `gpu-2`
that is managed separately):

| Container | Host | IP:Port | NPM public hostnames | Role |
|-----------|------|---------|---------------------|------|
| **vm104** | `docker-1-pve-104` | `192.168.54.111:8094` | `jarvis.gw-1-nbg-1-*`, `jarvis.gw-1-vie-1-*` | Primary |
| **gra-1** | `docker-1-pve-1-gra-1-fr-ovh` | `192.168.116.11:8094` | `jarvis-gra.gw-1-nbg-1-*`, `jarvis-gra.gw-1-vie-1-*` | DR clone |
| **lim-1** | `docker-1-pve-1-lim-1-de-ovh` | `192.168.115.11:8094` | `jarvis-lim.gw-1-nbg-1-*`, `jarvis-lim.gw-1-vie-1-*` | DR clone |

All three are behind **NPM `mesh-admin` Basic Auth + Authelia two-factor** on
both mesh hubs (`nbg-1` and `vie-1`). Anonymous public probes return **401**.

---

## 2. Architecture

Each instance runs two Compose services:

- **`jarvis`** — Node.js 20 (slim) web app with:
  - Web UI (HTML/JS/CSS) + REST API on port `:8094`
  - Playwright Chromium for browser-based tests
  - `openssh-client` for mesh-internal MCP servers (vm104 only for some)
  - Global `@eargollo/vikunja-mcp@1.2.3` for Vikunja integration
  - Persistent volume `jarvis_data:/data` (SQLite conversation store)

- **`neo4j`** — Neo4j 5.26.31 Community Edition knowledge graph:
  - No published ports
  - APOC plugin enabled
  - Heap 512 MB / 1 GB, pagecache 512 MB
  - Persistent volume `neo4j_data:/data`

### 2.1 Networks

- Default compose network (`jarvis_default`) for inter-service communication
- External bridge `authelia_shared-vikunja` for Vikunja MCP reachability
- All ports bound LAN-only (private `vmbr1` IP on the Docker host)
- No public ports; only accessible via NPM reverse proxy over the WireGuard mesh

### 2.2 What the image ships

The Dockerfile copies only `server.js`, `graphdb.js`, `mcp/` and `public/`
into `/app` (plus the global `@eargollo/vikunja-mcp` install). `tests/`,
`docker-compose.yml` and the `.env*` files are host-side only. Host-tree
stray files (e.g. the old root-level `app.js`/`style.css` debris on vm104)
are not part of the app.

### 2.3 API surface

| Endpoint | Method(s) | Auth | Description |
|----------|-----------|------|-------------|
| `/api/health` | GET | None | Health check (200, carries `appVersion`) |
| `/api/login` | POST | None | Session login (200/403) |
| `/api/logout` | POST | Session | Session logout |
| `/api/config` | GET | Session | App configuration + MCP list + `appVersion` |
| `/api/conversation` | GET/POST | Session | Conversation history CRUD |
| `/api/chat` | POST | Session | AI chat completion |
| `/api/transcribe` | POST | Session | Whisper audio transcription |
| `/api/speak` | POST | Session | TTS speech synthesis |
| `/api/endpoint-test` | GET | Session | Test provider endpoints |
| `/api/costs` | GET | Session | OpenRouter + OVHcloud + ElevenLabs costs |
| `/api/graph/status` | GET | Session | Graph DB status |
| `/api/graph/subgraph` | GET | Session | Subgraph query |
| `/api/graph/entity` | GET | Session | Entity lookup |
| `/api/graph/search` | GET | Session | Graph search |
| `/api/graph/schema` | GET | Session | Graph schema |
| `/api/graph/activity` | GET | Session | Graph activity |
| `/api/websearch/sources` | GET/POST/PATCH/DELETE | Session | Per-user web search sources |

---

## 3. Endpoint profiles

### 3.1 Brain (LLM) profiles

Defined via env vars in `.env`. Default profile set by `BRAIN_PROFILE_DEFAULT`.

| Profile | Env prefix | Model / Provider |
|---------|-----------|-----------------|
| Default | `BRAIN_*` | A1 GPU-2 DeepSeek V4 Flash |
| A1 Qwen | `BRAIN_A1_QWEN_*` | GPU-1 Qwen3.8-27B |
| OVHCloud | `BRAIN_OVHCLOUD_*` | OVHcloud AI |
| OpenRouter | `BRAIN_OPENROUTER_*` | OpenRouter |
| Claude Code | `BRAIN_CLAUDECODE_*` | Claude Code (via host-side exporter) |

### 3.2 Whisper (speech-to-text)

| Endpoint | Env prefix | Description |
|----------|-----------|-------------|
| Default | `WHISPER_*` | Default Whisper endpoint |
| GPU-1 | `WHISPER_GPU1_*` | A1 GPU-1 Whisper |
| VM103 | `WHISPER_VM103_*` | RW VM103 Whisper |
| OVHCloud | `WHISPER_OVHCLOUD_*` | OVHcloud Whisper |

### 3.3 TTS (text-to-speech)

- **Provider:** GPU-1 Kokoro-82M (`TTS_*` env vars)
- **ElevenLabs:** Server-side, env-gated via `ELEVENLABS_*` (key, base URL,
  voice id, model id). When enabled, the Answer-voice selector offers the
  provider's voice catalog (paginated fetch, 10 min cache) and `/api/speak`
  proxies to it; `/api/costs` shows remaining characters.
- **Voice profiles:** Built-in `hal9000` (mainframe), `default` (neural),
  character and named voices, plus ElevenLabs provider voices
- **Thinking line:** while the brain runs, a short deterministic line is
  spoken (`Let me think.` / `Lass mich kurz nachdenken.`, 2026-10-23), and
  the conversation panel shows a one-cell animated thinking spinner in the
   pending entry (braille dots, opencode main-session style; 2026-10-26)

### 3.4 Wake phrase

`WAKE_PHRASE=Hey Rocky` (default)

---

## 4. MCP servers

### 4.1 Built-in MCPs (all containers)

| MCP id | Type | Tools | Source |
|--------|------|-------|--------|
| `websearch` | Internal | `web_search`, `web_news`, `web_fetch` | `mcp/websearch.mjs` v1.4.0 |
| `vikunja` | Child process | 55 tools (write on, delete off) | `/usr/local/bin/vikunja-mcp` v1.2.3 |
| `graph` | Internal | Neo4j graph read/write | `mcp/graph.mjs` |
| `github-ro` | Child process, env-gated | Read-only GitHub (4 tools) | `mcp/github-readonly.mjs` |

`github-ro` (2026-10-23): read-only GitHub access — `github_repo_info`,
`github_list_directory`, `github_get_file`, `github_search_code`. Registered
only when `GITHUB_READONLY_ALLOWED_REPOS` is set (wildcard patterns
supported, e.g. `kirks2003/*`); the token, default repo and optional API base
come from the other `GITHUB_READONLY_*` vars. The allowlist is enforced both
when the tools are listed and at dispatch. Deployed on all three private
containers (runbook: `rw_mesh/docs/jarvis-github-mcp-readonly.md`).

> **Deployment note (2026-10-26 audit):** the 2026-10-25 file deploy
> overwrote the host `server.js` and silently removed the `github-ro`
> registration from the running containers (the `mcp/github-readonly.mjs`
> file and the host `.env` vars survived). This repo's `server.js` restores
> the wiring; deploying it re-enables the MCP on hosts that carry the env
> vars.

### 4.2 Mesh-internal MCPs (vm104 only, env-gated)

These give Jarvis direct SSH/API access to mesh infrastructure — kept on
vm104 only per owner decision (privacy boundary):

| MCP id | Access method | Targets |
|--------|--------------|---------|
| `ssh-nbg` | SSH → `mcp-bash` server on nbg-1 | Host shell on nbg-1 |
| `ssh-vie1` | SSH → `mcp-bash` server on vie-1 | Host shell on vie-1 |
| `sem-nbg` | SSH → `semaphore-mcp` on nbg-1 | Semaphore automation |
| `sem-vie1` | SSH → `semaphore-mcp` on vie-1 | Semaphore automation |
| `kandev-nbg` | SSH → mcp-stdio-bridge on nbg-1 | Kandev MCP on nbg-1 |
| `kandev-vie1` | SSH → mcp-stdio-bridge on vie-1 | Kandev MCP on vie-1 |
| `kandev-vm104` | Local streamable HTTP | Kandev MCP on vm104 (`:38431/mcp`) |
| `checkmk-nbg` | Checkmk REST API | gra-1 Checkmk 2.5 |
| `checkmk-vie1` | Checkmk REST API | lim-1 Checkmk 2.5 |

> **Privacy boundary (owner decision, 2026-10-21):** The nine mesh-internal
> MCPs are vm104-only. `gpu-2` (a1-jarvis) must NOT receive them. The code
> is brand-neutral and fully env-gated — a server only starts when its env
> vars are set.

### 4.3 MCP default-on behavior (2026-10-23)

In fresh browser profiles, all MCP switches are now **on by default**.
If a browser has persisted `jarvis.mcp.* = false` from earlier sessions,
toggle on once (or clear those keys) to adopt the new default.

### 4.4 External MCP argument normalization (2026-10-25)

`mcp/normalize-external-args.cjs` coerces brain-supplied arguments for
external (mesh-internal + github-ro) MCP calls against each tool's
`inputSchema` (string coercion, local-repo path inference for Kandev
`create_task_kandev`, …) before dispatch; failures fall back to the raw
args. Covered by `tests/mcp.test.mjs`.

---

## 5. Login and authentication

### 5.1 External (NPM) auth layer

- **Basic Auth:** NPM access list `mesh-admin` (NBG list 1, VIE-1 list 8)
- **Authelia two-factor:** Global `server_proxy.conf` include enforces
  Authelia on all NPM proxy hosts
- **Anonymous public probes:** 401 (Basic gate)
- **With valid Basic credentials:** 302 → Authelia login → app

### 5.2 App-level login

`POST /api/login` with `{username, password}` from the `USERS` env var.
Format: comma-separated `name:password` pairs (bare names: password is the
name). Session-based (cookie).
Example: `USERS=Mila:password,Roman:password2,admin:password3`

### 5.3 `a1-jarvis` (gpu-2)

Separate deployment hosted at `92.39.59.7`, loopback-only `127.0.0.1:8094`.
Brand: `BRAND=a1` (white theme, a1 logo). Public via NPM row 11
(`jarvis.gpu-2-de-fra-1-exo.csdc-nm.at`, 401 Basic).

- Has its own Neo4j + Vikunja instances
- No cost panel (no `/api/costs` backend)
- No mesh-internal MCPs
- Codebase diverges — port changes from **this repo** manually

---

## 6. DR clone (gra-1 / lim-1)

### 6.1 Deployment layout

```
/home/ubuntu/docker/jarvis-dr/
├── jarvis/            # Compose project "jarvis"
│   ├── docker-compose.yml
│   └── .env
└── vikunja/           # Compose project "vikunja"
    ├── docker-compose.yml
    └── .env
```

### 6.2 Nightly sync (systemd timer on nbg-1)

- **Script:** `scripts/host/jarvis-dr-sync.sh` (in `rw_mesh`)
- **Service:** `jarvis-dr-sync.service` (oneshot, `TimeoutStartSec=30min`)
- **Timer:** `jarvis-dr-sync.timer` — `OnCalendar=*-*-* 03:17:00`,
  `RandomizedDelaySec=15m`, `Persistent=true`
- **Sync path:** nbg-1 → stop primary containers → tar volumes →
  restart primary → relay to **both** DR targets with sha256 verification →
  restore on DR → gate on `running|healthy` + `/api/health` 200
- **Does NOT sync:** `.env` files (host-specific), application code
  (code updates deploy separately to all three trees)

### 6.3 Failover

On primary loss, change the upstream of NPM rows 44/56 (nbg-1/vie-1
`jarvis.`) from `192.168.54.111` to `192.168.116.11` (gra) or
`192.168.115.11` (lim) + `node /app/scripts/regenerate-config -y` in the
NPM container. Single-field DB edit per hub, ~2 min.

---

## 7. Release versioning

- **Source of truth:** `APP_RELEASE_VERSION` in `server.js` (env-overridable
  via the `APP_RELEASE_VERSION` env var since 2026-10-24), exposed in
  `/api/health` and `/api/config` and shown in the UI header
- Bump on every shipped Jarvis app/runtime change
- Must be identical on all 3 deployments after rollout
- Policy details: `VERSIONING_POLICY.txt`
- Latest: `2026.10.26-3`

### 7.1 Release notes

- **`2026.10.26-3` (this repo):** thinking indicator swapped from the
  one-cell comet to opencode's main-session braille spinner
  (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ cycled at 80 ms, uniform brightness; the 30 s pacing
  and per-frame opacity pulse went with it). Rolled out to all three
  hosts 2026-10-26.
- **`2026.10.26-2` (this repo):** repo move to `rw_jarvis`; `server.js`
  merged from the 2026-10-24 host backup + the 2026-10-25
  `normalize-external-args` fix (restores the `github-ro` registration,
  ElevenLabs server side and persona-memory wiring that the 2026-10-25
  deploy had lost); one-cell thinking indicator in the conversation panel
  (comet, since replaced by `2026.10.26-3`); test suite updated to the
  documented 2026-10-23 behavior. Rolled out to all three hosts
  2026-10-26 (re-enabling the env-gated features on hosts whose `.env`
  carries the vars).
- **`2026.10.25-1`:** external MCP `create_task_kandev` argument
  normalization.
- **`2026.10.24-02` (host-only, never in git):** ElevenLabs voice provider
  (UI + server), appearance settings, graph controls, `github-ro` MCP
  wiring, persona memory, env-overridable version marker.

---

## 8. Cost panel

Shown on vm104 only (no cost panel on gpu-2). Polled every 60 s while
visible. Backend calls provider APIs directly from vm104 with in-memory
TTL cache.

| Section | Provider | Refresh | Data |
|---------|----------|---------|------|
| OpenRouter | `api.openrouter.ai` | 300 s | Balance, used month/lifetime, free-tier flag |
| OVHcloud | `eu.api.ovh.com/1.0` | 3600 s | Invoice list, AI current-month tokens/cost |
| ElevenLabs | `api.elevenlabs.io` | 600 s | Remaining characters, plan tier |

Force refresh: click the small "Refresh" button (sends `?fresh=1` to bypass
TTL).

---

## 9. Testing

### 9.1 Unit tests

```bash
npm test
# node --test tests/*.test.mjs
# Baseline: 205/205 pass
```

### 9.2 Browser tests

```bash
npm run test:browser
# node --test tests/*.browser.mjs
# pipeline.browser.mjs + graph.browser.mjs
# Baseline: 64 pass / 0 fail / 2 skipped
```

The 2 skips are intentional live-vm103 backend tests (real Whisper
transcription + real brain cycles).

### 9.3 Deploy pattern

1. Dated backup to `/home/ubuntu/jarvis-backups/<ts>/`
2. `scp` changed files to the target host
3. `docker compose build jarvis`
4. `docker compose up -d --no-build --pull never --force-recreate jarvis`
5. md5-verify in-container files match disk
6. Re-run test suites and compare against baseline
7. Verify `/api/health` 200 **and** that `appVersion` equals the new
   `APP_RELEASE_VERSION`
8. Deploy to **all three** hosts in lockstep, and only changed files — a
   partial file deploy from an older source tree is how the 2026-10-25
   regression happened (the host `server.js` was replaced by a git version
   that lacked uncommitted newer code)

---

## 10. Secrets and configuration

- All secrets live only in host-local `.env` files (never in this repo)
- `.env.example` documents the key names (no values)
- Host-local env files beyond `.env`: `.env.elevenlabs` (vm104; the compose
  `env_file` list requires the file to exist on a host — create an empty
  one on hosts without ElevenLabs)
- Provider API keys are piped over SSH between hosts — never printed or stored
- The `USERS` env var contains login credentials (never committed)
- `ELEVENLABS_API_KEY` and `GITHUB_READONLY_TOKEN` are host-local secrets
  (key names documented in `.env.example`)
- GitHub tokens for `rw_jarvis` / `rwnix-infra` pushes use one-shot PAT
  URLs — never stored in any repo

---

## 11. Conventions for AI assistants

- Read existing files before editing
- Check `git status` and `git log --oneline -5` before making changes
- Do not commit unless explicitly asked
- Use conventional commit message format
- Keep the Markdown Index at the bottom of this file: for every new or updated
  `.md` file, add or update its index entry
- All secrets and credentials must stay in host-local `.env` files — never in
  any committed file
- **This repo is the single source of truth for the app.** If you discover
  newer code on a host (host-side edits, backups, container files), import it
  here — never the other way around
- Deploy app changes to **all three** private containers (`vm104`, `gra-1`,
  `lim-1`) unless the owner requests a limited rollout
- `a1-jarvis` on `gpu-2` is a separate clone with separate repo and policy
- For major structural changes, run both unit and browser test suites
- Bump `APP_RELEASE_VERSION` on every shipped change
- The nightly DR sync copies volumes only — code updates must be deployed
  separately to all three trees

---

## Markdown Index

| File | Description |
|---|---|
| AGENTS.md | This file — deployment overview, architecture, endpoints, MCP servers, auth, DR, release notes, testing, conventions. |
| README.md | Product documentation: pipeline, voice, MCP integrations, graph model, login, language switch. |
| DEPLOYMENT.md | Deployment history and runbook: live service, from-scratch setup, snapshot backup/restore, public NPM routes, per-change deployment log. |
| VERSIONING_POLICY.txt | Version bump + lockstep deployment policy for `APP_RELEASE_VERSION`. |
