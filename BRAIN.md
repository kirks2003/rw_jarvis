# BRAIN.md — The Jarvis LLM brain

The "brain" is the reasoning LLM Jarvis calls for every answer. It runs behind an
OpenAI-compatible `/chat/completions` endpoint. The selectable **profiles** (which
model/provider the brain uses) are in AGENTS.md §3.1; this file covers the
**per-request dials**, the **model context limits**, the **context-trim guard**,
the **persona**, and the **tuning tradeoffs**.

Because the brain is a *reasoning* model (it spends tokens thinking before it
answers), three independent per-request dials bound a single brain run. Each is
settable in `.env`, overridable **per browser** from the endpoint panel, and rides
with each `/api/chat` request.

## 1. The three per-request dials

| Dial | Env default | Request field | Server clamp | What it bounds |
|---|---|---|---|---|
| **Brain timeout** | `BRAIN_TIMEOUT_MS` (50 s) | `brainTimeoutMin` | 1–600 min | Wall clock for the whole run (every LLM round + every MCP round-trip). The browser waits out the same budget client-side. |
| **Brain token budget** | `BRAIN_MAX_TOKENS` (4096) | `brainMaxTokens` | 1K–2048K (1K = 1024 tokens) | `max_tokens` for the answer — covers the thinking tokens too. |
| **Brain tool rounds** | `BRAIN_TOOL_ROUNDS` (else `GRAPH_TOOL_ROUNDS` = 5) | `brainToolRounds` | 1–1000 | How many MCP tool-call rounds the brain may chain before the backend forces a final answer. |

Per-browser storage keys: `jarvis.brainTimeoutMin`, `jarvis.brainBudgetK`,
`jarvis.brainToolRounds`. All three are clamped server-side (`server.js`).

They are **independent** and bound different things:
- **timeout** bounds the *time*;
- **token budget** bounds the *output tokens*;
- **tool rounds** bound the *number of tool calls*.

A long multi-step ask may need more of **each** — e.g. "read this repo, then
SSH-test logins on every host" needs many tool rounds, generous time for them, and
enough output tokens for the final answer.

### The two "budgets" (a common confusion)

"Token budget" and "tool budget" are different things and produce different butler
messages — this is the source of "the app is getting a budget problem again":

- **Token budget exhausted** → the model returns `finish_reason: "length"` with
  empty content; the brain reports it "spent its whole token budget on reasoning".
  Fix: raise the **token budget** (and the timeout to match).
- **Tool budget exhausted** → the backend has made N tool rounds and forces a final
  answer ("Tool budget reached. Answer now from what you have gathered."); the butler
  relays it (German: "das Tool-Budget für diesen Durchlauf alle ist"). This is a
  **feature**, not a crash, and it is **not** logged as an error — it is the brain's
  *answer*. Fix: raise the **tool rounds**. See FINDINGS.md for the triage.

## 2. Model context windows and the safe-max token cap

The token budget you set is **additionally capped at the model's safe maximum**
before it is sent — `server.js` `PROFILE_SAFE_MAX_TOKENS` /
`profileSafeMaxTokens(profile)`. So setting the full 2048K just means "as much as
this model can take" and can never 400 on `max_tokens … greater than max_model_len`
(the cap leaves room for the prompt, so output stays under the model's total
context).

Per-profile safe output ceilings (2026-10-26):

| Profile id | Model | Total context | Safe output cap sent |
|---|---|---|---|
| `a1-deepseek` (default) | DeepSeek V4 Flash | 1,000,000 | 512K |
| `openrouter-deepseek` | DeepSeek (via OpenRouter) | 1,000,000 | 512K |
| `ovhcloud` | Qwen3.6-27B | 262,144 | 128K |
| `a1-qwen`, `claudecode`, and any other | Qwen3.8-27B / Claude / large-context | large | 512K (`DEFAULT_SAFE_MAX_TOKENS`) |

> **Finding (2026-10-26):** the local `gguf` / DeepSeek endpoints do **not**
> report their context length — `/v1/models` returns `context_length: null` and the
> true limit only appears in the 400 body (`max_model_len`). So the safe-max cap is
> a **hardcoded per-profile map**, not a runtime query. When you add or change a
> profile, update `PROFILE_SAFE_MAX_TOKENS` (see FINDINGS.md).

## 3. The context-trim guard (2026.10.26-11)

The running brain context only **grows**: every tool round appends the assistant's
tool call plus its results (`local` in `runBrain` is only ever appended to, never
trimmed). A long tool run (a high `brainToolRounds`) therefore overflows the
model's **input** window, which the model rejects with a 400 "maximum context
length …" — and that 400 used to discard the **whole** answer and all the tool
work behind it.

The guard (`isContextOverflow` + `trimOldestToolExchange` in `server.js`) catches
that specific 400 (matched on the response **body**, so a bad-key / bad-model 400
still errors), sheds the **oldest** tool exchange (the assistant's tool call plus
its results, keeping the most recent) and **retries the same round**. Net effect: a
high round count degrades to "less of the early results in context" and still
finishes, instead of failing.

## 4. Tuning: what a high tool-round count actually costs

Raising `brainToolRounds` to a large value (e.g. 1000) does **not** mean 1000
useful calls — the binding limit is the **model's input context window**, not the
round counter. The three real costs:

1. **Context overflow** — now handled by the trim guard (degrades, doesn't fail).
   Without it a long run 500s and loses all prior tool work.
2. **Time** — each round is an LLM call + an MCP round-trip; the whole run is
   bounded by the Brain timeout (which can be minutes or hours if the timeout
   slider is high).
3. **Cost / GPU occupancy** — every round re-processes the *whole* growing context,
   so token (and thus cost / GPU-time) usage grows **super-linearly** with the
   number of rounds, even though only the latest result is new.

**Guidance (the "plan" for setting the dial):**
- Default **5 rounds** is fine for a schema call plus a few follow-ups.
- A genuinely multi-step ask ("read this repo, then SSH-test logins on every
  host") typically needs **20–40** rounds; set that, not 1000, and pair it with a
  generous Brain timeout (minutes, not the 50 s default).
- **1000** is the ceiling for pathological cases, not a recommended setting — it
  maximises time and cost and mostly just trims its way through.
- For a long *answer* (not a long tool run), raise the **token budget**, not the
  rounds.

## 5. Per-user persona (2026-10-26)

The persona is no longer a single hardcoded butler. Each owner can store their own
personality in the knowledge graph (one `:Personality` node per owner — free text,
`updated_at`, capped at 2000 chars; a separate label so it never pollutes `:Entity`
listings). With the graph toggle on, the stored persona **replaces** the default
`BRAIN_SYSTEM_PROMPT` butler for that user's requests; graph off (or no persona)
falls back to the butler. The brain manages it via the graph MCP's
`get-personality` (read) and `set-personality` (write, owner-scoped for regular
sessions, any registered owner for admin) tools. Details in AGENTS.md §3.1.

## 6. Native tool-call recovery (2026-10-26)

Some models answer with their **native** tool-call XML inside `content` instead of
the OpenAI `tool_calls` field. `graphdb.parseToolCallsFromContent` recovers those
calls so they are executed, not spoken/rendered. The special-token fence varies
between builds (ASCII-pipe `<|invoke|` and the fullwidth-bar "DSML" dialect
`<｜DSML｜invoke`), so every fence slot is matched leniently. The dispatcher also
canonicalises the tool name before routing (some models "clean" `store-entity` to
`store_entity`). Details in AGENTS.md §4.5.
