# DR verification 2026-10-27 — gra-1 + lim-1 while the primary (vm104) is down

Dated verification that both DR clones fully replicate the primary Jarvis
instance during the **planned pve104 downtime** (vm104 `192.168.54.111`
offline, as expected). Answer: **both DR instances are fully functional** at
`2026.10.26-11`, after recovering a corrupted Neo4j state caused by the
nightly sync (below).

## Topology used

| Hub (public) | DR target | Host |
|---|---|---|
| nbg-1 `gw-1-nbg-1-de-netcup.rwnix.net` (152.53.118.212) | gra-1 `192.168.116.11:8094` | `docker-1-pve-1-gra-1-fr-ovh` |
| vie-1 `gw-1-vie-1-at-netcup.rwnix.net` (152.53.35.177) | lim-1 `192.168.115.11:8094` | `docker-1-pve-1-lim-1-de-ovh` |

Both hubs reach both DR hosts over the mesh (`ssh ubuntu@…`). App dir on each
host: `/home/ubuntu/docker/jarvis-dr/jarvis/` (compose project `jarvis` +
sibling `vikunja/`).

## Code parity

Deployed code on both hosts (disk **and** in-container) md5-matches this repo
exactly — the repo is the source of truth, confirmed:

- `server.js` `1ced4fd0b18277e4397c4296f9480ead`
- `public/app.js` `2ff729db3aa3d460039fbcc974d5adae`
- `public/index.html` `d3cd7c16645c239b052abdf5da740dd0`
- `public/style.css` `4339f99c4b9e8fd56e8e9005a0dabd63`

`/api/health` on both: `{"ok":true,"appVersion":"2026.10.26-11",
"whisperEndpoints":3,"brainConfigured":true,"aiProfiles":5,"ttsEndpoints":1}`.

## Feature matrix (gra-1 and lim-1 — identical results)

| Feature | Result |
|---|---|
| Login (`admin`, `Roman`; bare-name convention) | 200, session cookie works |
| Brain — 5 profiles configured (default `a1-deepseek`; a1-qwen, ovhcloud, openrouter, openrouter-deepseek; `claudecode` intentionally unconfigured) | all `/api/endpoint-test` pass; real `/api/chat` returns the answer |
| MCP — 13 registered (websearch, graph, vikunja, ssh-nbg, ssh-vie1, sem-nbg, sem-vie1, kandev-nbg, kandev-vie1, kandev-vm104, checkmk-nbg, checkmk-vie1, github-ro), all env-gated vars set | registered in `/api/config`; live round-trips below |
| MCP live round-trips | `ssh-nbg` + `ssh-vie1` return their hostnames; vikunja as Roman → `projects=2` (admin has no Vikunja account, by design); graph status 369 nodes / 563 edges |
| Whisper | gpu-1 OK, ovhcloud OK, **vm103 FAILED** (see mesh-wide note) |
| TTS | Kokoro `ttsEndpoints:1` OK; ElevenLabs live (44 voices, remaining-character balance in costs) |
| Graph | status/schema/search/subgraph/entity all OK after the Neo4j recovery below; full-text search `Berlin`→1, `mesh`→6; `Rocky`→0 is **correct** (no such `:Entity` — `/api/graph/entity?name=Rocky` → 404) |
| History DB (SQLite `/data/conversations.db`) | 600 conversations (Roman 559, Mila 41), `conversation_embeddings` 600 (0 unembedded), `websearch_sources` 140 — synced from vm104, fully readable; the live UI probe wrote a new turn through the real pipeline |
| Costs panel | openrouter / ovhcloud / elevenlabs all live (balances shown in the UI) |
| Live UI (Playwright Chromium, repo `tests/*.browser.mjs` stack) | `LIVE-PROBE-OK` on both: UI login → boot (Version 2026.10.26-11) → manual prompt → `POST /api/chat` 200 → answer "LIVE UI OK" → `POST /api/conversation` 200. Screenshots show the full UI (all 11 MCP switches on, costs panel, pipeline) |

Probe notes (for reuse): plain-HTTP fetches in the container need a
`crypto.randomUUID` polyfill; bare `USERS` names mean *password = the name
itself*; `USERS` entries carry a leading space after each comma — trim when
parsing; the headless probe must turn the **Speak** switch off (headless
Chromium has no TTS voices, so the thinking-line utterance would otherwise
block the brain request).

## Tests

- **Unit** (`npm test`): **216/216 pass** — matches the documented baseline.
- **Browser** (`npm run test:browser`): **67 pass / 1 fail / 2 skipped**
  (baseline 68/0/2). The one failure — `tests/graph.browser.mjs:193`
  "the Remove button deletes the centred entity and refreshes the panel" — is
  a **flaky harness timeout**, not an app bug: isolated re-runs pass 1 in 3,
  and on failure the app request itself was correct (`centerSeen==="n0"`,
  neighbourhood shown). Timing artifact under sandbox load. Re-run before
  treating it as a regression. The 2 skips are the intentional live-vm103
  backend tests.
- **Live UI probe**: both hosts pass (see matrix).

## Neo4j incident: both DR graphs were in *critical error*

**Found:** `jarvis-neo4j` on both DR hosts in `critical` state since
2026-10-26 16:36 UTC — `AlreadyClosedException: Underlying file changed by an
external force at 2026-10-26T02:18:09Z`. The 2026-10-22 "file was deleted
while running" event in the same logs is the same class of fault.

**Root cause:** the nightly DR restore (nbg-1 `jarvis-dr-sync.sh`) overwrote
the `neo4j_data` volume **while the DB was still running**. The script's stop
step logs `no such service: jarvis-neo4j` — it addresses the wrong service
name, so the stop silently fails and the restore proceeds against a live DB.

**Secondary bug surfaced:** with the graph down, a `GET /api/graph/status`
probe crashed the gra-1 `jarvis` process (unhandled neo4j driver error — the
endpoint should 503, not kill the process).

**Fix applied (both hosts):** `docker restart jarvis-neo4j` (clean "Started"),
then `docker restart jarvis`. Both jarvis logs then show
`graph_indexes_ready created:6`; graph back to 369 nodes / 563 edges; all
graph endpoints and the live UI probe pass. Post-fix state on both:
`jarvis` up (healthy), `jarvis-neo4j` up (healthy), `vikunja` + `vikunja-db`
unaffected.

## Mesh-wide (not DR-specific)

- **vm103/pve103 is down** (`192.168.53.111` unreachable from gra-1; pve103
  `192.168.15.7` does not respond). The `vm103` whisper profile is dead until
  that host returns. The default whisper profile is gpu-1 (works), so voice
  input is unaffected on both DR instances.

## Recommendations / plan (not yet done — none live in this repo)

1. **Patch `rw_mesh` `scripts/host/jarvis-dr-sync.sh`:** stop the DR
   `jarvis-neo4j` container (correct service name) *and verify the stop
   succeeded* before restoring `neo4j_data`; after restore, gate on
   `jarvis-neo4j` healthy (not just `jarvis` + `/api/health`) before
   restarting the app. This is the recurring-corruption root cause.
2. **Harden `server.js`:** the graph endpoints should catch neo4j driver
   errors and return 503 ("graph unavailable") instead of letting an unhandled
   driver error crash the whole `jarvis` process.
3. **vm103:** restore the host; until then leave the `vm103` whisper profile
   in place (it self-reports failed in `/api/endpoint-test`) and rely on the
   gpu-1 default.

No `APP_RELEASE_VERSION` bump: this was verification + operational recovery,
no app code changed.
