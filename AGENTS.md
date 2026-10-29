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
| `/api/conversation` | GET/POST/DELETE | Session | Conversation history CRUD; DELETE removes the caller's turns (admin: all users') |
| `/api/chat` | POST | Session | AI chat completion |
| `/api/transcribe` | POST | Session | Whisper audio transcription |
| `/api/speak` | POST | Session | TTS speech synthesis |
| `/api/endpoint-test` | GET | Session | Test provider endpoints |
| `/api/costs` | GET | Session | OpenRouter + OVHcloud + ElevenLabs costs |
| `/api/graph/status` | GET | Session | Graph DB status |
| `/api/graph/subgraph` | GET | Session | Subgraph query |
| `/api/graph/entity` | GET/DELETE | Session | Entity lookup; DELETE removes one entity (caller's own, admin: any) |
| `/api/graph/all` | DELETE | Session | Delete all graph data for the caller (admin: every user's); `:User` nodes kept |
| `/api/graph/search` | GET | Session | Graph search |
| `/api/graph/schema` | GET | Session | Graph schema |
| `/api/graph/activity` | GET | Session | Graph activity |
| `/api/websearch/sources` | GET/POST/PATCH/DELETE | Session | Per-user web search sources |

---

## 3. Endpoint profiles

### 3.1 Brain (LLM) profiles

Defined via env vars in `.env`. Default profile set by `BRAIN_PROFILE_DEFAULT`.

> **Deep reference: `BRAIN.md`** — the three per-request dials (timeout / token
> budget / tool rounds), the model context windows + safe-max token map, the
> context-trim guard, the per-user persona, and the tuning tradeoffs (what a high
> tool-round count actually costs). Investigation findings and operational
> lessons: `FINDINGS.md`.

| Profile | Env prefix | Model / Provider |
|---------|-----------|-----------------|
| Default | `BRAIN_*` | A1 GPU-2 DeepSeek V4 Flash |
| A1 Qwen | `BRAIN_A1_QWEN_*` | GPU-1 Qwen3.8-27B |
| OVHCloud | `BRAIN_OVHCLOUD_*` | OVHcloud AI |
| OpenRouter | `BRAIN_OPENROUTER_*` | OpenRouter |
| Claude Code | `BRAIN_CLAUDECODE_*` | Claude Code (via host-side exporter) |

**Brain timeout (2026-10-26):** one overall deadline bounds each brain run
(LLM rounds + MCP tool round-trips). The default is `BRAIN_TIMEOUT_MS`
(env, 50 s); the endpoint panel's **Brain timeout** slider (1–600 min,
saved per browser) rides with each `/api/chat` as `brainTimeoutMin`, the
server clamps it to that range and uses it instead of the default, and the
browser waits out the same budget client-side. Long MCP chains (e.g. a
Kandev task) no longer end in a "signal timed out".

**Brain token budget (2026-10-26):** the brain is a reasoning model, so its
per-answer `max_tokens` covers its thinking tokens too — an undersized
budget is spent on reasoning and the reply comes back empty
(`finish_reason "length"`, "The brain spent its whole token budget on
reasoning"). The endpoint panel's **Brain token budget** control (a 1K–2048K
slider plus a text field for exact values; both hold the same K, where
1K = 1024 *tokens*, and whichever is set takes effect, saved per browser)
rides with each `/api/chat` as `brainMaxTokens`; the server clamps it to that
window and uses it as `max_tokens` (default `BRAIN_MAX_TOKENS` env, 4096).
The value actually sent is **additionally capped at the model's safe
maximum** (a per-profile map: deepseek-v4-flash is 1,000,000 total context →
512K output, which is also the default for the large-context Qwen/Claude
profiles; the OVH Qwen3.6-27B is known to be 262,144 → 128K), so setting the
full 2048K just means "as much as this model can take" and can never 400 on
"max_tokens ... greater than max_model_len". It bounds the *tokens*, not the
time — the Brain timeout slider above still bounds the wall clock, so the two
work together: a bigger budget needs enough time to generate.

**Brain tool rounds (2026-10-26):** every MCP tool (graph, web search,
Vikunja, `github-ro`, the mesh-internal ssh/semaphore/checkmk servers, …)
shares one per-request budget of **tool-call rounds** — the brain may make at
most N tool rounds on one answer, after which the backend forces a final
answer ("Tool budget reached. Answer now from what you have gathered"). The
default is `GRAPH_TOOL_ROUNDS` = 5 (`BRAIN_TOOL_ROUNDS` env to override); the
endpoint panel's **Brain tool rounds** control (a 1–1000 slider plus a text
field for exact values, saved per browser) rides with each `/api/chat` as
`brainToolRounds`, and the server clamps it to that range. Multi-step asks
("read this repo and test logins on every host") need more than 5 rounds;
raise the slider or type an exact value for them. The whole run is still
bounded by the Brain timeout above (the time) **and** by the model's context
window: because the running context only grows (tool results are appended,
never trimmed), a long run can overflow the model input window, which a model
rejects with a 400 "maximum context length …" that would otherwise discard the
whole answer. The **context-trim guard** (2026-10-26) catches that 400, sheds
the *oldest* tool exchange (the assistant's tool call plus its results) and
retries the same round, so a high round count degrades to "less of the early
results in context" and still finishes instead of failing.

**Per-user persona (2026-10-26):** the assistant's persona is no longer a
single hardcoded butler. Each owner can store their own personality in the
knowledge graph (one `:Personality` node per owner — free text, `updated_at`,
capped at 2000 chars; a separate label so it never shows up in `:Entity`
knowledge listings). With the graph toggle on, the user's stored persona
**replaces** the default `BRAIN_SYSTEM_PROMPT` butler for their requests;
graph off (or no persona stored) falls back to the butler. The brain manages
it via the graph MCP's `get-personality` (read; all owners for admin) and
`set-personality` (write; owner-scoped for regular sessions, any registered
owner for admin) tools, so "speak German with me and use du" takes effect
from the user's next request.

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
  pending entry (braille dots, opencode main-session style; 2026-10-26).
  The spinner always animates — the `prefers-reduced-motion` freeze was
  dropped on 2026-10-26 (owner requirement; the glyph swap carries no
  spatial motion)

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

### 4.5 Brain native tool-call recovery (2026-10-26)

The brain is offered tools via the OpenAI `tools` field, but DeepSeek/Qwen
behind the OpenAI-compatible proxy intermittently answer with the model's
NATIVE tool-call XML inside `content` instead of the `tool_calls` field.
`graphdb.parseToolCallsFromContent` recovers those calls so they are executed
(not spoken/rendered as the answer). The special-token fence around each tag
name varies between builds — old ASCII-pipe (`<|invoke|`) and the newer
fullwidth-bar "DSML" dialect (`<｜DSML｜invoke`) — so every fence slot is
matched leniently (an empty fence, or any run of ASCII/fullwidth bars with an
optional "DSML" between). The dispatcher also canonicalises the tool name
before routing (some models "clean" `store-entity` to `store_entity`); names
that match no static tool (the namespaced external + Vikunja tools) pass
through unchanged. Covered by `tests/graph.test.mjs`.

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

> **Known issue (2026-10-27, recurred 2026-10-29):** the script's stop step
> fails (`no such service: jarvis-neo4j`), so `neo4j_data` is restored while
> the DR Neo4j is still running and ends up in *critical error* state
> (happened on both gra-1 and lim-1 after the 2026-10-26 run; recurred on
> both after the 2026-10-29 run; each time fixed by restarting
> `jarvis-neo4j` + `jarvis`). The corruption is latent until the first query
> that touches the affected pages, so a host can look healthy for hours and
> only break when someone opens the graph panel. The sync script must stop
> the DR neo4j correctly and gate the restore on the DB being healthy. Full
> verification report + fix plan: `DR_VERIFICATION_2026-10-27.md`.
>
> **Crash hardening (2026.10.29-3):** while the DR DBs sat in critical-error
> state, every graph request on those hosts took the whole `jarvis` process
> down (an unhandled rejection from the neo4j driver's connection-pool path,
> `neo4j-driver` 5.28.3) → container restart → every in-memory login session
> wiped → the browser's next request was a 403 "forbidden" loop. `server.js`
> now installs a `process.on("unhandledRejection")` handler that logs
> (`level: "error"`, `msg: "unhandled_rejection"`) and keeps serving, so a
> broken DB degrades to `502 graph_unavailable` on the graph endpoints
> instead of a crash loop; `graphdb.js` additionally observes every branch of
> its `Promise.all` fan-outs (`allObserved`) so a failing database rejects
> exactly once. Covered by unit tests (store fan-out rejects once; backend
> survives a spawned unhandled rejection and stays serving).

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
- Latest: `2026.10.29-5`
  
### 7.1 Release notes
  
- **`2026.10.29-5` (this repo):** fixed the Kandev MCP "Unknown tool" — all
  three Kandev servers (nbg-1, vie-1, vm104) returned "Unknown tool" for every
  call even though the MCP servers were healthy. The Kandev MCP names every
  tool with a redundant `_kandev` suffix (`list_workspaces_kandev`,
  `create_task_kandev`, …); namespaced as `<id>_<tool>` that became
  `kandev-nbg_list_workspaces_kandev` — a double "kandev". The brain "cleans"
  the redundant suffix and calls `kandev-nbg_list_workspaces`, a name the
  dispatch lookup didn't have (external names pass through
  `canonicalizeToolName` unchanged), so every call fell through to "Unknown
  tool". The servers themselves were fine — a direct MCP handshake from each
  host lists all 42–47 tools. The new `externalToolDisplayName` helper
  (`mcp/external-tool-name.cjs`, kandev servers only) drops the redundant
  suffix from the *offered/lookup* name so the brain's natural call matches;
  the dispatch still uses the original tool name for the real MCP call, so arg
  normalization and the upstream call are unaffected. Verified end-to-end on
  gra-1: the brain now calls `kandev-vm104_list_workspaces` and
  `kandev-nbg_list_workspaces` and gets real workspace data back (both
  dispatched `ok:true`). Rolled out to all three hosts 2026-10-29.
- **`2026.10.29-4` (this repo):** restored graph reads — and with them the
  brain's ability to write to the graph — on all hosts. The persona read
  (`readContext`) fans out three parallel Cypher queries (traits, preferences,
  episodes); the **episode** query bound `ep:Episode` but ordered by
  `t.confidence` / `t.importance` / `t.decay_score`, an undeclared variable
  neo4j rejects at compile time. `readContext()` therefore threw on every
  graph-on request, the `chat()` handler's catch told the brain the graph was
  "currently unreachable" (the graph write-tool instructions are pushed inside
  the same try-block as the read), and the brain refused to store anything —
  "I'm afraid I can't permanently persist data into long-term storage at the
  moment". The **preference** query had the identical alias typo (fixed in
  `2026.10.29-3`); the episode query's was missed. Fixed the ORDER BY to
  reference `ep.*` and added a regression test that pins all three persona
  queries to their bound aliases. Verified against the live neo4j on all three
  hosts (the exact `readContext` call that was throwing now returns the user's
  entities + persona). Rolled out to all three hosts 2026-10-29.
- **`2026.10.29-3` (this repo):** made a broken knowledge-graph database a
  degraded panel instead of a crash loop. When a Neo4j sits in *critical
  error* state (the recurring nightly-sync corruption, see §6.2), `status()`
  fans out three parallel queries: the first rejection reached the endpoint's
  catch (a 502), but the neo4j driver (5.28.3) also rejects an internal
  connection-pool promise the app never observes — an unhandled rejection
  that Node ≥ 15 turns into a process crash → container restart → every
  in-memory login session wiped → the browser's next request is a 403
  "forbidden" loop (this is what the DR hosts did on 2026-10-29). Two
  layers of hardening: (1) `server.js` installs a
  `process.on("unhandledRejection")` handler that logs
  (`level: "error"`, `msg: "unhandled_rejection"`, error + stack) and keeps
  serving — any stray async error degrades the affected request, never the
  process; (2) `graphdb.js` observes every branch of its `Promise.all`
  fan-outs via a new `allObserved` helper (status, schema, persona read), so
  a failing database rejects exactly once with a clean
  `graph_unavailable` 502. Also fixed a latent typo in the persona
  preference read (the query bound `p:Preference` but referenced
  `t.confidence` / `t.updated_at` — undeclared variable; it could never have
  succeeded, and the caller's catch silently fell back to no persona).
  Covered by unit tests (a store whose driver always rejects surfaces
  `status`/`schema` as exactly one error and no unhandled rejections; a
  backend that receives a spawned unhandled rejection logs it and keeps
  serving).
  Rolled out to all three hosts 2026-10-29 (the DR hosts' `jarvis-neo4j` was
  also restarted to clear the critical-error state).
- **`2026.10.29-2` (this repo):** fixed the server-side request deadlines that
  had silently stopped firing inside the container. The app bounds four
  outbound calls with `AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`
  (the Whisper per-attempt timeout, both TTS providers' per-attempt timeouts,
  and the brain's overall deadline), but Node 20's undici never aborts a fetch
  whose signal is an `AbortSignal.any()` composite — the composite signal
  fires, the in-flight request keeps waiting — so a hung Whisper/TTS endpoint
  or a hung brain call blocked the request forever in the `node:20-slim`
  image (it only worked on Node ≥ 24, which is why the host test suites, run
  on the hosts' newer Node, never caught it; the in-container suite does). The
  new `combinedSignal(signal, ms)` helper wires a plain `AbortController` to
  both sources (caller abort + per-attempt deadline) instead, which aborts
  reliably on every Node version. Behavior on Node ≥ 24 is unchanged (same
  timeouts, same error wording). Covered by the pre-existing
  "hung Whisper returns a bounded timeout" unit test, which now also passes in
  the container's Node 20. Rolled out to all three hosts 2026-10-29.
- **`2026.10.29-1` (this repo):** two destructive "delete all" buttons, each
  scoped to the signed-in account's own data and each asking for a second,
  explicit confirm before it sends anything. (1) The **History search** panel
  gained a **Delete all prompt history** button (`DELETE /api/conversation`):
  a regular user deletes only their own stored turns, the **admin** session
  deletes every account's turns; the derived embedding vectors are removed
  with the turns (the declared `ON DELETE CASCADE` is inert because SQLite's
  foreign-keys pragma is off, so the endpoint deletes both tables explicitly),
  and the in-memory short-term cache is dropped for the affected account(s) so
  the brain's next turn starts clean. (2) The **Knowledge graph** panel — and
  the full-size graph page — gained a **Delete all graph data** button
  (`DELETE /api/graph/all` → new `graphStore.removeAll` on both the Neo4j and
  memory stores): a regular user wipes their own world (entities, fact edges,
  stored persona), the **admin** wipes every user's world; `:User` account
  nodes are structural markers, never data, so they survive and the account's
  world comes back empty but intact. The admin flag is derived server-side
  from the session, never from the client, so a regular user's call can never
  reach another account's rows. Covered by unit tests (store-level isolation
  + cypher pinning; endpoint scoping for both deletes) and browser tests
  (confirm dismissed → no request; confirm accepted → one request, panel
  refreshes). Rolled out to all three hosts 2026-10-29.
- **`2026.10.26-11` (this repo):** two changes to the brain's per-request
  tool-rounds dial. (1) The **Brain tool rounds** range went up to **1–1000**
  (was 1–60) and gained a companion **text field** for exact values next to the
  slider (both hold the same count, whichever you set takes effect, committed
  on blur/Enter, saved per browser) — a long tool run is easier to type than
  to drag, and a multi-step ask ("read this repo, then SSH-test logins on
  every host") can be given many rounds without a code change. (2) A new
  **context-trim guard** in the brain loop: because the running context only
  grows (tool results are appended, never trimmed), a long run can overflow
  the model's input window, which a model rejects with a 400 "maximum context
  length …" that would otherwise discard the whole answer and all the tool
  work behind it. The guard catches that specific 400 (matched on the body, so
  a bad-key/bad-model 400 still errors), sheds the *oldest* tool exchange
  (the assistant's tool call plus its results, keeping the most recent) and
  retries the same round — so a high round count degrades to "less of the
  early results in context" and still finishes. Covered by a unit test (mock
  brain that 400s on context length) and a browser test (text field + 1000
  range). Rolled out to all three hosts 2026-10-26.
- **`2026.10.26-10` (this repo):** two changes to the brain's per-request
  dials. (1) The **Brain token budget** ceiling went back up to **2048K**
  (1K = 1024 tokens) so the panel offers the full range again; the value
  actually sent to a model is now additionally capped at that model's safe
  maximum (a per-profile map: deepseek-v4-flash 1,000,000 total context →
  512K output, the default for the large-context Qwen/Claude profiles; the
  OVH Qwen3.6-27B is 262,144 → 128K), so a high value means "as much as this
  model can take" and can never 400 on "max_tokens ... greater than
  max_model_len". (2) A new **Brain tool rounds** slider (1–60, saved per
  browser) in the endpoint panel rides with each `/api/chat` as
  `brainToolRounds`: it is the shared per-request tool-call-round budget that
  every MCP tool (github, ssh, graph, web, vikunja, …) draws on, previously a
  fixed `GRAPH_TOOL_ROUNDS` = 5. It is now overridable per browser (and via
  the `BRAIN_TOOL_ROUNDS` env), still bounded by the Brain timeout, so a
  multi-step ask that hit the old "tool budget exhausted" wall (e.g. read a
  repo, then SSH-test logins on every host) can be given more rounds. Rolled
  out to all three hosts 2026-10-26.
- **`2026.10.26-9` (this repo):** two fixes. (1) The brain token budget
  ceiling was lowered from 2048K to **512K** (1K = 1024 tokens): the old
  ceiling let a user request more output tokens than the model's total
  context (deepseek-v4-flash `max_model_len` = 1,000,000), which the model
  rejects with HTTP 400 "max_tokens ... greater than max_model_len". 512K
  stays safely below that while leaving room for the prompt, and is still
  100× more than any answer needs (the model stops when the reply is done;
  the budget is only a ceiling). (2) The `jarvis` container's log now
  rotates by size (Docker `json-file` driver, 10 MB × 5 files = 50 MB max)
  so all app errors persist to a bounded, rotating file — the Docker-native
  equivalent of logrotate (see §9.4). Rolled out to all three hosts
  2026-10-26.
- **`2026.10.26-8` (this repo):** the endpoint panel's **Brain token
  budget** control gained a companion **text field** next to the slider. Both
  hold the same K value and whichever you set takes effect: dragging the
  slider updates the field, and typing an exact value (committed on
  blur/Enter, clamped to 1K..2048K, non-numeric reverts to the last value)
  moves the slider. No new request field — the field just sets the same
  `brainMaxTokens` the slider already sent. Rolled out to all three hosts
  2026-10-26.
- **`2026.10.26-7` (this repo):** the endpoint panel gained a **Brain token
  budget** slider (1K–2048K, saved per browser) that rides with each
  `/api/chat` as `brainMaxTokens`; the server clamps it to that window and
  uses it as the brain's per-answer `max_tokens` (default `BRAIN_MAX_TOKENS`
  env, 4096). The brain is a reasoning model, so an undersized budget is
  spent on reasoning and the reply comes back empty
  ("The brain spent its whole token budget on reasoning and returned no
  answer") — the slider lets a complex ask get more room to think and answer
  without a code change. It bounds the tokens, not the time; the Brain
  timeout slider still bounds the wall clock. The graph-extraction call keeps
  its own fixed 4096 budget. Rolled out to all three hosts 2026-10-26.
- **`2026.10.26-6` (this repo):** fixed the native tool-call XML leak. The
  brain (DeepSeek/Qwen behind the OpenAI-compatible proxy) intermittently
  returns its NATIVE tool-call markup inside `content` instead of the OpenAI
  `tool_calls` field; the backend's `parseToolCallsFromContent` fallback was
  only tolerant of the OLD ASCII-pipe dialect (`<|invoke| name="...">`).
  Newer builds emit a FULLWIDTH-bar / "DSML" dialect (`<｜DSML｜invoke
  name="...">`) that the parser did not recognise, so the raw XML was spoken
  and rendered in the conversation panel instead of being executed. The
  fence is now matched leniently in every slot (empty, or any run of
  ASCII/fullwidth bars with an optional "DSML" between), and the dispatcher
  canonicalises the tool name before routing (some models "clean"
  `store-entity` to `store_entity`) so the call still reaches the right tool.
  Rolled out to all three hosts 2026-10-26.
- **`2026.10.26-5` (this repo):** two features. (1) The endpoint panel's
  cost section gained an on/off **switch** (top-right, below Sign out, saved
  per browser): off hides the cost panel and the page reflows; polling and
  the backend billing cache keep running regardless. (2) The assistant
  persona is now **per-user and stored in the knowledge graph** instead of a
  single hardcoded butler: one `:Personality` node per owner (free text +
  `updated_at`, capped at 2000 chars), separate from `:Entity` so it never
  pollutes knowledge listings. With the graph toggle on, a user's stored
  persona REPLACES the default `BRAIN_SYSTEM_PROMPT` butler for that user's
  requests; the brain manages it through new `get-personality` (read) and
  `set-personality` (write, owner-scoped for regular sessions, any registered
  owner for admin) MCP tools, so the user can say "speak German with me and
  use du" and it takes effect from their next request. Rolled out to all
  three hosts 2026-10-26.
- **`2026.10.26-4` (this repo):** the braille thinking spinner now
  always animates (the `prefers-reduced-motion` freeze was dropped — the
  glyph swap carries no spatial motion), and the endpoint panel gained a
  **Brain timeout** slider (1–600 min, saved per browser) that rides with
  each `/api/chat` request as `brainTimeoutMin`; the server clamps it and
  uses it as the overall brain deadline (`BRAIN_TIMEOUT_MS` env sets the
  default, 50 s) instead of a fixed 50 s, and the browser waits out the
  same budget client-side — long MCP tool runs (e.g. a Kandev task) no
  longer end in a "signal timed out". Rolled out to all three hosts
  2026-10-26.
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
# Baseline: 224/224 pass
```

### 9.2 Browser tests

```bash
npm run test:browser
# node --test tests/*.browser.mjs
# pipeline.browser.mjs + graph.browser.mjs
# Baseline: 71 pass / 0 fail / 2 skipped
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

### 9.4 App log (rotating)

Every app log line (structured JSON: `level` info/warn/error, plus
requestId/msg/stack) goes to the container's stdout/stderr, which Docker's
`json-file` logging driver writes to a file and **rotates by size**
(compose `logging:` on the `jarvis` service: `max-size: 10m`, `max-file: 5`
= 50 MB max). This is the Docker-native equivalent of logrotate; the host
`logrotate` must NOT also manage the container log file. All request errors
(e.g. `Brain HTTP 400 …`) are logged at `level: "error"`.

```bash
docker logs --tail 200 jarvis                      # recent lines
docker logs -f jarvis                              # follow
docker logs jarvis | grep '"level":"error"'        # errors only
# rotated segments: /var/lib/docker/containers/jarvis/*-json.log*
```

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
- The kirks2003 GitHub PAT used to push/merge to `main` lives in the
  gitignored hidden file `.git-credentials` at this kandev workspace's repo
  root (mode 600, `git credential store` format: `https://<user>:<token>@github.com`).
  It is local to this workdir, never committed and never printed. Agents use
  it with `git -c credential.useHttpPath=false -c credential.helper=
  -c credential.helper="store --file=$PWD/.git-credentials" push origin main`
  (see §11).

---

## 11. Conventions for AI assistants

- Read existing files before editing
- Check `git status` and `git log --oneline -5` before making changes
- Do not commit unless explicitly asked
- Use conventional commit message format
- **Pushing/merging to `main`:** use the kirks2003 PAT in the gitignored
  `.git-credentials` at this workspace's repo root (see §10) —
  `git -c credential.useHttpPath=false -c credential.helper=
  -c credential.helper="store --file=$PWD/.git-credentials" push origin main`.
  Never print the token, and never commit `.git-credentials`.
- **Concurrent merges to `main`:** another agent/process can merge to `main`
  while you are working. **Always `git fetch origin` and rebase/merge before
  `git push`**, then confirm your push landed
  (`git log --oneline origin/main -1` shows your commit). A push after a stale
  fetch is a non-fast-forward — rebase and push again; **never force-push**.
- **Keep the doc baselines current:** the test baselines in §9.1/§9.2 and the
  `Latest` version in §7 are updated on every rollout — bump them in the same
  commit as the release so a fresh reader is never pointed at a stale count.
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
| BRAIN.md | The LLM brain deep-reference: the three per-request dials (timeout / token budget / tool rounds), model context windows + safe-max token map, the context-trim guard, per-user persona, and tuning tradeoffs (what a high tool-round count costs). |
| FINDINGS.md | Dated investigation findings & operational lessons: triaging "budget problem" reports, the context-overflow 400, model context discovery, the concurrent-`main`-merge caution, the partial-deploy regression lesson, log/diagnostic shortcuts. |
| DR_VERIFICATION_2026-10-27.md | 2026-10-27 DR verification during the pve104 downtime: feature matrix for gra-1 + lim-1 (MCP/AI/history DB/live UI), test results, the Neo4j critical-error root cause (nightly sync) + fix, and the open fix plan (rw_mesh sync script, server.js graph hardening, vm103 outage). |
| README.md | Product documentation: pipeline, voice, MCP integrations, graph model, login, language switch. |
| DEPLOYMENT.md | Deployment history and runbook: live service, from-scratch setup, snapshot backup/restore, public NPM routes, per-change deployment log. |
| VERSIONING_POLICY.txt | Version bump + lockstep deployment policy for `APP_RELEASE_VERSION`. |
