# FINDINGS.md — Investigation findings & operational lessons

A dated log of things we diagnosed, discovered, or learned while working on
`rw_jarvis`. Keep entries terse and high-signal. Brain *configuration* lives in
BRAIN.md; deployment history lives in DEPLOYMENT.md; the app architecture in
AGENTS.md. Use this file to answer "why did X happen / what did we learn / what
gotcha should I know?".

## 2026-10-27

### The nightly DR sync corrupts the DR Neo4j (volume overwritten while the DB runs)
- **Found:** while verifying gra-1 + lim-1 during the planned pve104
  downtime, both DR `jarvis-neo4j` containers were in `critical` state
  (`AlreadyClosedException: Underlying file changed by an external force at
  2026-10-26T02:18:09Z`).
- **Root cause:** nbg-1 `jarvis-dr-sync.sh` restores `neo4j_data` while the DB
  is still running — its stop step logs `no such service: jarvis-neo4j`
  (wrong service name), so the stop silently fails and the restore hits a
  live DB. The 2026-10-22 "file was deleted while running" event is the same
  class of fault.
- **Fix applied:** `docker restart jarvis-neo4j` then `docker restart jarvis`
  on both hosts → `graph_indexes_ready created:6`, graph fully back.
- **Lesson:** never restore a database volume while the DB runs; the sync
  script must stop the *right* service, verify the stop, and gate the restore
  on the DB being healthy afterwards. Plan: patch the script in `rw_mesh`.
  Full report: `DR_VERIFICATION_2026-10-27.md`.

### A dead graph can crash the whole `jarvis` process
- With Neo4j in `critical` state, `GET /api/graph/status` killed the gra-1
  `jarvis` process (unhandled neo4j driver error). The graph endpoints should
  503 "graph unavailable", not take the app down with them. Plan: harden
  `server.js` (open item, see `DR_VERIFICATION_2026-10-27.md`).

### Browser-suite flake: graph Remove-button test
- `tests/graph.browser.mjs:193` ("the Remove button deletes the centred
  entity and refreshes the panel") failed 2 of 3 isolated re-runs, but the app
  request itself was correct on failure (`centerSeen==="n0"`, neighbourhood
  shown) — a harness timeout under sandbox load, not an app bug. Re-run once
  before treating it as a regression.

## 2026-10-26

### "The app is getting a budget problem again" — it was the brain's *answer*, not a crash
- **Reported symptom:** the butler told the user the tool budget was exhausted
  ("das Tool-Budget für diesen Durchlauf alle ist") while doing a multi-step mesh
  task (read `kirks2003/rw_mesh` files + SSH-test logins on every host).
- **Diagnosis:** `docker logs jarvis | grep '"level":"error"'` → **0 error lines**
  in the whole log. No `brain_empty_answer`, no `Brain HTTP 400`, no
  `finish_reason:"length"`. So there was no fault — the "budget problem" was the
  **brain's own answer** relaying the backend's "Tool budget reached" nudge (the
  tool-round cap doing its job), not a crash.
- **Log evidence:** the request made 6 tool calls (`github_get_file`×2,
  `ssh-nbg`×2, `ssh-vie1`×2) plus a second request with 2 — i.e. it had run into
  the then-fixed **5-round** cap and was forced to a final answer. That cap became
  the per-browser **Brain tool rounds** dial (2026.10.26-10, widened to 1–1000 in
  2026.10.26-11).
- **Lesson:** a "budget" complaint is usually a *dial*, not an *error*. Triage
  order: (1) grep the log for `error`; (2) if empty, it's the brain's answer →
  raise the matching dial (tool rounds / token budget / timeout); (3) if there is
  an error line, it's a real fault.

### The context-overflow 400 used to discard the whole answer
- The running brain context only **grows** (tool results are appended, never
  trimmed). A long tool run overflows the model **input** window → the model
  returns a 400 "maximum context length …" → without handling, the whole
  `/api/chat` 500s and **all the tool work is lost**.
- **Fix (2026.10.26-11):** the **context-trim guard** — on that specific 400, shed
  the oldest tool exchange and retry the round, so a high round count degrades to
  "less early context" and still finishes. See BRAIN.md §3.

### Local models don't report their context window
- `/v1/models` returns `context_length: null` for the local `gguf` (Qwen3.8-27B)
  and DeepSeek endpoints; the real limit only surfaces in the 400 body
  (`max_model_len`, e.g. DeepSeek V4 Flash = 1,000,000). Hosted models *do* report
  it (e.g. OpenRouter `openai/gpt-6.1-terra` = 1,050,000; OVH Qwen3.6-27B =
  262,144).
- **Consequence:** the token-budget safe-max cap is a **hardcoded per-profile map**
  (`PROFILE_SAFE_MAX_TOKENS` in `server.js`), not a runtime query. **When you add
  or change a brain profile, update that map** with the model's real context.

### Operational: concurrent merges to `main`
- Another agent/process can merge to `main` while you are working. **Always
  `git fetch origin` and rebase/merge before `git push`**, then confirm your push
  landed (`git log --oneline origin/main -1` shows your commit). A push after a
  stale fetch is a non-fast-forward — resolve it (rebase) and push again; **never
  force-push**.

### Operational: the 2026-10-25 partial-deploy regression (recurring lesson)
- A targeted file deploy from a **stale source tree** overwrote the host
  `server.js` and silently dropped newer (never-committed) wiring (`github-ro`,
  ElevenLabs, persona memory). The file on disk was valid JS, so nothing errored —
  the features just vanished from the running containers.
- **Lesson:** before deploying, confirm the source tree's md5s are exactly the
  ones you intend to ship, and deploy **only changed files** to **all three hosts
  in lockstep**. The repo is now the single source of truth, which makes this
  rarer — but still md5-verify before and after.

### Diagnostic shortcuts
- The app log is structured JSON on the container stdout; Docker rotates it by size
  (AGENTS.md §9.4). Recent lines: `docker logs --tail 200 jarvis`; errors only:
  `docker logs jarvis | grep '"level":"error"'`.
- Confirm the running version: `curl -s <vmbr1-ip>:8094/api/health` → `appVersion`
  must equal the new `APP_RELEASE_VERSION`. (vm104 `192.168.54.111`, gra-1
  `192.168.116.11`, lim-1 `192.168.115.11` — the app binds the vmbr1 IP, not
  `localhost`.)
- The three brain dials (timeout / token budget / tool rounds) are independent —
  see BRAIN.md §1 for which one to raise for a given symptom.
