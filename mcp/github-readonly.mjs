import readline from "node:readline";

const GITHUB_API_BASE_URL = String(process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || "").trim();
const allowedRepos = String(process.env.GITHUB_ALLOWED_REPOS || "kirks2003/rw_mesh")
  .split(",")
  .map((repo) => repo.trim())
  .filter(Boolean);
const DEFAULT_REPO = String(process.env.GITHUB_DEFAULT_REPO || allowedRepos[0] || "").trim();
const USER_AGENT = String(process.env.GITHUB_USER_AGENT || "jarvis-github-readonly-mcp/1.0");

function allowRuleMatches(rule, repo) {
  const r = String(rule || "").trim().toLowerCase();
  const q = String(repo || "").trim().toLowerCase();
  if (!r || !q) return false;
  if (r === q) return true;
  if (!r.includes("*")) return false;
  const escaped = r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(q);
}

function repoAllowed(repo) {
  return allowedRepos.some((rule) => allowRuleMatches(rule, repo));
}

const TOOL_SCHEMAS = [
  {
    name: "github_repo_info",
    description: "Read repository metadata (default branch, visibility, stars, forks, issue count).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo. Must be in the allowed list." },
      },
    },
  },
  {
    name: "github_list_directory",
    description: "List entries in a repository directory (name, path, type, size).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo. Must be in the allowed list." },
        path: { type: "string", description: "Directory path in the repository." },
        ref: { type: "string", description: "Optional branch, tag, or commit SHA." },
      },
    },
  },
  {
    name: "github_get_file",
    description: "Read a UTF-8 text file from a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo. Must be in the allowed list." },
        path: { type: "string", description: "File path in the repository." },
        ref: { type: "string", description: "Optional branch, tag, or commit SHA." },
      },
      required: ["path"],
    },
  },
  {
    name: "github_search_code",
    description: "Search code in the allowed repository (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo. Must be in the allowed list." },
        query: { type: "string", description: "Code search query without repo: qualifiers." },
        per_page: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 10, max 20)." },
      },
      required: ["query"],
    },
  },
];

function text(content) {
  return { isError: false, content: [{ type: "text", text: content }] };
}

function failure(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function resolveRepo(inputRepo) {
  const repo = String(inputRepo || DEFAULT_REPO || "").trim();
  if (!repo) {
    throw new Error("No repository configured. Set GITHUB_ALLOWED_REPOS or pass repo.");
  }
  if (!repoAllowed(repo)) {
    throw new Error(`Repository not allowed: ${repo}. Allowed: ${allowedRepos.join(", ")}`);
  }
  return repo;
}

function buildUrl(pathname, params) {
  const url = new URL(`${GITHUB_API_BASE_URL}${pathname}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function githubJson(pathname, params) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": USER_AGENT,
  };
  if (GITHUB_TOKEN) headers.authorization = `Bearer ${GITHUB_TOKEN}`;
  const response = await fetch(buildUrl(pathname, params), {
    headers,
  });
  const body = await response.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed?.message || body || `HTTP ${response.status}`;
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return parsed;
}

function decodeUtf8Base64(content) {
  const buffer = Buffer.from(String(content || "").replace(/\n/g, ""), "base64");
  return buffer.toString("utf8");
}

function renderDirectory(repo, path, ref, entries) {
  const rows = [];
  rows.push(`Repository: ${repo}`);
  rows.push(`Path: ${path || "/"}`);
  if (ref) rows.push(`Ref: ${ref}`);
  rows.push("");
  rows.push("| Type | Name | Path | Size |");
  rows.push("|---|---|---|---:|");
  for (const entry of entries) {
    rows.push(`| ${entry.type} | ${entry.name} | ${entry.path} | ${Number(entry.size || 0)} |`);
  }
  return rows.join("\n");
}

function renderRepoInfo(repoInfo) {
  return [
    `Repository: ${repoInfo.full_name}`,
    `Description: ${repoInfo.description || "(none)"}`,
    `Default branch: ${repoInfo.default_branch}`,
    `Private: ${Boolean(repoInfo.private)}`,
    `Archived: ${Boolean(repoInfo.archived)}`,
    `Stars: ${Number(repoInfo.stargazers_count || 0)}`,
    `Forks: ${Number(repoInfo.forks_count || 0)}`,
    `Open issues: ${Number(repoInfo.open_issues_count || 0)}`,
    `URL: ${repoInfo.html_url}`,
  ].join("\n");
}

function renderSearchResults(repo, query, items) {
  const lines = [];
  lines.push(`Repository: ${repo}`);
  lines.push(`Query: ${query}`);
  lines.push(`Results: ${items.length}`);
  lines.push("");
  for (const item of items) {
    lines.push(`- ${item.path}`);
    lines.push(`  URL: ${item.html_url}`);
  }
  return lines.join("\n");
}

async function runTool(name, args) {
  if (name === "github_repo_info") {
    const repo = resolveRepo(args.repo);
    const repoInfo = await githubJson(`/repos/${repo}`);
    return text(renderRepoInfo(repoInfo));
  }

  if (name === "github_list_directory") {
    const repo = resolveRepo(args.repo);
    const path = String(args.path || "").replace(/^\/+/, "");
    const ref = args.ref ? String(args.ref) : undefined;
    const response = await githubJson(`/repos/${repo}/contents/${path}`, { ref });
    const entries = Array.isArray(response) ? response : [response];
    const list = entries
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({ type: entry.type || "unknown", name: entry.name || "", path: entry.path || "", size: Number(entry.size || 0) }));
    return text(renderDirectory(repo, path, ref, list));
  }

  if (name === "github_get_file") {
    const repo = resolveRepo(args.repo);
    const path = String(args.path || "").replace(/^\/+/, "");
    if (!path) throw new Error("path is required");
    const ref = args.ref ? String(args.ref) : undefined;
    const response = await githubJson(`/repos/${repo}/contents/${path}`, { ref });
    if (Array.isArray(response) || response.type !== "file") {
      throw new Error(`Path is not a file: ${path}`);
    }
    if (response.encoding !== "base64") {
      throw new Error(`Unsupported file encoding: ${response.encoding || "unknown"}`);
    }
    const content = decodeUtf8Base64(response.content || "");
    const header = [`Repository: ${repo}`, `Path: ${path}`];
    if (ref) header.push(`Ref: ${ref}`);
    header.push("");
    const MAX_BYTES = 120000;
    const output = Buffer.byteLength(content, "utf8") > MAX_BYTES
      ? `${content.slice(0, MAX_BYTES)}\n\n[truncated at ${MAX_BYTES} bytes]`
      : content;
    return text(`${header.join("\n")}\n${output}`);
  }

  if (name === "github_search_code") {
    const repo = resolveRepo(args.repo);
    const query = String(args.query || "").trim();
    if (!query) throw new Error("query is required");
    if (/\brepo\s*:/i.test(query)) {
      throw new Error("Do not include repo: in query. The repository is enforced separately.");
    }
    const perPage = Math.max(1, Math.min(20, Number(args.per_page || 10)));
    const response = await githubJson("/search/code", {
      q: `${query} repo:${repo}`,
      per_page: perPage,
      page: 1,
    });
    const items = Array.isArray(response.items) ? response.items : [];
    return text(renderSearchResults(repo, query, items));
  }

  return failure(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "github-readonly", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") {
    return { tools: TOOL_SCHEMAS };
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
    return runTool(name, args);
  }
  return {};
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id === undefined) return;
  try {
    const result = await handleRequest(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    const result = failure(String(error.message || error));
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }
});
