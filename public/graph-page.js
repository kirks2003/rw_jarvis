// The full-size knowledge graph page (/graph.html), opened in its own tab
// from the app's graph panel. Same data and same two renderers as the panel,
// but filling the viewport and starting at 150% entity/link-text size. Its
// slider values are stored under their own key, so this view keeps its larger
// default without touching the panel's sizes.
import { createGraph3D } from "./graph3d.js";
import { renderGraph2d } from "./graph2d.js";

const el = {};
for (const id of ["graphStatus", "graphCanvas", "graph3dStage", "graphView2dButton", "graphView3dButton",
  "graphEdgeBrightness", "graphEdgeBrightnessValue", "graphEntityLimit", "graphEntityLimitValue", "graphNodeSize", "graphNodeSizeValue", "graphTextSize", "graphTextSizeValue", "graphRefreshButton", "graphHint",
  "graphSearch", "graphSearchStatus", "graphSearchClear", "graphSearchResults", "graphUser"]) {
  el[id] = document.getElementById(id);
}

const sizesStorageKey = "jarvis.graphSizes.full";
const legacySizesStorageKey = "jarvis.graphSizes.full.3d";
const DEFAULT_SCALE_PERCENT = 150;
const GRAPH_ENTITY_LIMIT_MIN = 20;
const GRAPH_FETCH_LIMIT = 1000;

let config = null;
let graphCenter = null;
let graphView = "3d";
let graph3d = null;
let graph3dUnavailable = false;
let lastSubgraph = null;
let lastGraphStatus = null;
const graphDisplay = { edgeBrightness: 1, entityLimit: Number(el.graphEntityLimit.value) || 200, node: 1.5, text: 1.5 };
let pendingGraphEntityLimit = null;

function graphStatusUrl(force = false) {
  return force ? `/api/graph/status?refresh=${Date.now()}` : "/api/graph/status";
}

function syncGraphEntityLimitMax(totalNodes) {
  if (!Number.isFinite(totalNodes)) return;
  const dynamicMax = Math.max(GRAPH_ENTITY_LIMIT_MIN, Math.floor(totalNodes));
  el.graphEntityLimit.max = String(dynamicMax);
  const requested = Number.isFinite(pendingGraphEntityLimit)
    ? Math.floor(pendingGraphEntityLimit)
    : Number(el.graphEntityLimit.value);
  const clamped = Math.max(GRAPH_ENTITY_LIMIT_MIN, Math.min(dynamicMax, requested));
  el.graphEntityLimit.value = String(clamped);
  pendingGraphEntityLimit = null;
  graphDisplay.entityLimit = Number(el.graphEntityLimit.value);
  el.graphEntityLimitValue.textContent = String(Math.round(graphDisplay.entityLimit));
}

function compareNodePriority(a, b, degreeMap, centerId) {
  const aIsCenter = centerId && a.id === centerId ? 0 : 1;
  const bIsCenter = centerId && b.id === centerId ? 0 : 1;
  if (aIsCenter !== bIsCenter) return aIsCenter - bIsCenter;
  const aIsUserMarker = a.type ? 1 : 0;
  const bIsUserMarker = b.type ? 1 : 0;
  if (aIsUserMarker !== bIsUserMarker) return aIsUserMarker - bIsUserMarker;
  const aHops = Number.isFinite(a.hops) ? a.hops : Number.MAX_SAFE_INTEGER;
  const bHops = Number.isFinite(b.hops) ? b.hops : Number.MAX_SAFE_INTEGER;
  if (aHops !== bHops) return aHops - bHops;
  const aIsolated = a.isolated ? 1 : 0;
  const bIsolated = b.isolated ? 1 : 0;
  if (aIsolated !== bIsolated) return aIsolated - bIsolated;
  const aDegree = degreeMap.get(a.id) || 0;
  const bDegree = degreeMap.get(b.id) || 0;
  if (aDegree !== bDegree) return bDegree - aDegree;
  return String(a.id).localeCompare(String(b.id));
}

function subgraphFor3d(subgraph) {
  const sliderMax = Number(el.graphEntityLimit.max) || GRAPH_ENTITY_LIMIT_MIN;
  const limit = Math.max(GRAPH_ENTITY_LIMIT_MIN, Math.min(sliderMax, Math.floor(graphDisplay.entityLimit)));
  const nodes = subgraph?.nodes || [];
  if (nodes.length <= limit) return subgraph;
  const edges = subgraph?.edges || [];
  const degreeMap = new Map();
  const adjacency = new Map();
  for (const edge of edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1);
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1);
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }
  const sorted = [...nodes].sort((a, b) => compareNodePriority(a, b, degreeMap, graphCenter));
  const selectedIds = new Set(sorted.slice(0, limit).map((node) => node.id));
  const pinnedIds = new Set();
  if (graphCenter) pinnedIds.add(graphCenter);
  if (!graphCenter) {
    const rootNode = sorted.find((node) => node.hops === 0);
    if (rootNode && selectedIds.has(rootNode.id)) pinnedIds.add(rootNode.id);
  }
  const pruneDisconnected = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...selectedIds]) {
        if (pinnedIds.has(id)) continue;
        const neighbours = adjacency.get(id);
        let hasVisibleNeighbour = false;
        if (neighbours) {
          for (const neighbour of neighbours) {
            if (selectedIds.has(neighbour)) {
              hasVisibleNeighbour = true;
              break;
            }
          }
        }
        if (!hasVisibleNeighbour) {
          selectedIds.delete(id);
          changed = true;
        }
      }
    }
  };
  pruneDisconnected();
  for (const node of sorted) {
    if (selectedIds.size >= limit) break;
    if (selectedIds.has(node.id)) continue;
    const neighbours = adjacency.get(node.id);
    if (!neighbours) continue;
    for (const neighbour of neighbours) {
      if (selectedIds.has(neighbour)) {
        selectedIds.add(node.id);
        break;
      }
    }
  }
  for (const node of sorted) {
    if (selectedIds.size >= limit) break;
    selectedIds.add(node.id);
  }
  // The generic fill above can reintroduce one-off nodes whose neighbours sit
  // outside the limit. Prune once more so visible nodes keep visible links.
  pruneDisconnected();
  if (selectedIds.size === 0) {
    for (const node of sorted.slice(0, limit)) selectedIds.add(node.id);
  }
  const selected = sorted.filter((node) => selectedIds.has(node.id)).slice(0, limit);
  return {
    ...subgraph,
    nodes: selected,
    edges: edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
  };
}

function applyGraphScales() {
  document.documentElement.style.setProperty("--graph-node-scale", String(graphDisplay.node));
  document.documentElement.style.setProperty("--graph-text-scale", String(graphDisplay.text));
  el.graphEdgeBrightnessValue.textContent = `${Math.round(graphDisplay.edgeBrightness * 100)}%`;
  el.graphEntityLimitValue.textContent = String(Math.round(graphDisplay.entityLimit));
  el.graphNodeSizeValue.textContent = `${Math.round(graphDisplay.node * 100)}%`;
  el.graphTextSizeValue.textContent = `${Math.round(graphDisplay.text * 100)}%`;
  if (graph3d) {
    graph3d.setEdgeBrightness(graphDisplay.edgeBrightness);
    graph3d.setNodeScale(graphDisplay.node);
    if (lastSubgraph && graphView === "3d") graph3d.update(subgraphFor3d(lastSubgraph));
  }
  if (lastSubgraph && !el.graphCanvas.hasAttribute("hidden")) render2d(lastSubgraph);
  refreshShownStatus();
}

function refreshShownStatus() {
  if (!lastSubgraph || !lastGraphStatus || !Number.isFinite(lastGraphStatus.nodes) || !Number.isFinite(lastGraphStatus.edges)) return;
  const visible2d = lastSubgraph;
  const visible3d = subgraphFor3d(lastSubgraph);
  const shownCount = graphView === "3d" ? visible3d.nodes.length : visible2d.nodes.length;
  if (graphView === "3d") el.graphEntityLimitValue.textContent = String(shownCount);
  el.graphStatus.textContent = `${lastGraphStatus.nodes} nodes · ${lastGraphStatus.edges} links${graphCenter ? " · neighbourhood" : ""} · ${shownCount} shown`;
}

function onGraphScaleInput() {
  graphDisplay.edgeBrightness = Number(el.graphEdgeBrightness.value) / 100;
  graphDisplay.entityLimit = Number(el.graphEntityLimit.value);
  graphDisplay.node = Number(el.graphNodeSize.value) / 100;
  graphDisplay.text = Number(el.graphTextSize.value) / 100;
  try {
    const serialized = JSON.stringify({
      edgeBrightness: el.graphEdgeBrightness.value,
      entityLimit: el.graphEntityLimit.value,
      node: el.graphNodeSize.value,
      text: el.graphTextSize.value,
    });
    localStorage.setItem(sizesStorageKey, serialized);
    localStorage.setItem(legacySizesStorageKey, serialized);
  } catch {
    // Storage unavailable (private mode): the sliders still work for the
    // session.
  }
  applyGraphScales();
}

el.graphEdgeBrightness.addEventListener("input", onGraphScaleInput);
el.graphEntityLimit.addEventListener("input", onGraphScaleInput);
el.graphEntityLimit.addEventListener("change", onGraphScaleInput);
el.graphNodeSize.addEventListener("input", onGraphScaleInput);
el.graphTextSize.addEventListener("input", onGraphScaleInput);

// The 2D drawing lives in the SVG's own 640x360 user-unit box; the viewBox
// stretches it to the window, so "full size" needs no pixel maths here.
function render2d(subgraph) {
  renderGraph2d(el.graphCanvas, subgraph, {
    nodeScale: graphDisplay.node,
    userName: config?.user ?? null,
    onNodeClick: (nodeId) => loadGraph(nodeId),
    width: 640,
    height: 360,
    highlight: matchedIds.size || matchedRelTypes.size ? { nodeIds: matchedIds, relTypes: matchedRelTypes } : null,
  });
}

function failGraph3d(reason) {
  if (graph3dUnavailable) return;
  graph3dUnavailable = true;
  if (graph3d) {
    graph3d.dispose();
    graph3d = null;
  }
  el.graphView3dButton.disabled = true;
  el.graphView3dButton.title = reason;
  el.graphStatus.textContent = `${reason} — showing 2D`;
  setGraphView("2d");
}

function setGraphHint() {
  el.graphHint.textContent = graphView === "3d"
    ? "Drag to orbit, scroll to zoom, click an entity to centre on its neighbourhood. The visible-entities limit is shared with the main app in this browser."
    : "Search the graph, scroll to zoom, and click an entity to centre on its neighbourhood. The visible-entities limit is shared with the main app in this browser.";
}

function setGraphView(view) {
  graphView = view;
  const use3d = view === "3d" && !graph3dUnavailable && Boolean(config?.graphConfigured);
  // toggleAttribute, not the .hidden property: on SVG elements the property
  // does not reflect the attribute, so the [hidden] CSS would never lift.
  el.graph3dStage.toggleAttribute("hidden", !use3d);
  el.graphCanvas.toggleAttribute("hidden", use3d);
  el.graphView3dButton.classList.toggle("active", use3d);
  el.graphView2dButton.classList.toggle("active", !use3d);
  el.graphView3dButton.disabled = !config?.graphConfigured || graph3dUnavailable;
  el.graphView2dButton.disabled = !config?.graphConfigured;
  setGraphHint();
  if (use3d && !graph3d) {
    graph3d = createGraph3D(el.graph3dStage, {
      userName: config?.user || null,
      edgeBrightness: graphDisplay.edgeBrightness,
      nodeScale: graphDisplay.node,
      autoFit: true,
      onNodeClick: (nodeId) => loadGraph(nodeId),
      onFallback: () => failGraph3d("WebGL is not available in this browser"),
    });
  }
  if (lastSubgraph) {
    if (use3d && graph3d) {
      graph3d.update(subgraphFor3d(lastSubgraph));
    } else if (!use3d) {
      render2d(lastSubgraph);
    }
    refreshShownStatus();
  }
}

async function loadGraph(center, { forceStatus = false } = {}) {
  if (center !== undefined) graphCenter = center;
  if (!config?.graphConfigured) return;
  try {
    const [status, subgraph] = await Promise.all([
      fetch(graphStatusUrl(forceStatus), { cache: "no-store" }).then((response) => response.json()),
      fetch(`/api/graph/subgraph?limit=${GRAPH_FETCH_LIMIT}${graphCenter ? `&center=${encodeURIComponent(graphCenter)}` : ""}`, { cache: "no-store" }).then((response) => response.json()),
    ]);
    if (status.error) {
      el.graphStatus.textContent = status.error === "graph_unavailable" ? `Unreachable: ${status.message || "database down"}` : "Not available";
      return;
    }
    lastGraphStatus = status;
    syncGraphEntityLimitMax(status.nodes);
    lastSubgraph = subgraph;
    const visible2d = subgraph;
    const visible3d = subgraphFor3d(subgraph);
    const shownCount = graphView === "3d" ? visible3d.nodes.length : visible2d.nodes.length;
    if (graphView === "3d") el.graphEntityLimitValue.textContent = String(shownCount);
    el.graphStatus.textContent = `${status.nodes} nodes · ${status.edges} links${graphCenter ? " · neighbourhood" : ""} · ${shownCount} shown`;
    if (graphView === "3d" && graph3d) {
      graph3d.update(visible3d);
    } else {
      render2d(visible2d);
    }
  } catch (error) {
    el.graphStatus.textContent = `Unreachable: ${error.message}`;
  }
}

el.graphRefreshButton.addEventListener("click", () => loadGraph(null, { forceStatus: true }));
el.graphView3dButton.addEventListener("click", () => setGraphView("3d"));
el.graphView2dButton.addEventListener("click", () => setGraphView("2d"));

// --- Search ------------------------------------------------------------------
// The search runs on the server against a full-text index, so it covers the
// WHOLE graph, not just the nodes this page has loaded. Picking a hit re-centres
// the view on that entity's neighbourhood (the same bounded subgraph fetch a
// node click does), which is what keeps the page usable on a huge graph: the
// result list is paged, the drawing never is.
let searchTimer = null;
let searchSequence = 0;
let matchedIds = new Set();
let matchedRelTypes = new Set();
// The node a lone search hit already pulled into view, so a re-render of the
// same query does not fetch it again.
let focusLoadedFor = null;

// Dim whatever the current query does not match, in both views, so the search
// reads as a filter on the picture and not just a list beside it.
function applyMatchHighlight() {
  const active = matchedIds.size > 0 || matchedRelTypes.size > 0;
  if (graph3d) {
    graph3d.setHighlight(active ? { nodeIds: matchedIds, relTypes: matchedRelTypes } : null);
    // Narrowed to exactly one entity: the camera follows it from here, live —
    // the layout keeps moving the node, so this is a per-frame follow, not a
    // one-off recentre. setFocus ignores an id that is not drawn.
    graph3d.setFocus(singleMatchId());
  }
  if (lastSubgraph && !el.graphCanvas.hasAttribute("hidden")) render2d(lastSubgraph);
}

// The one entity the query is down to, or null while it still matches several
// (a link-type filter is a set of edges, never a single node to follow).
function singleMatchId() {
  return matchedIds.size === 1 && matchedRelTypes.size === 0 ? [...matchedIds][0] : null;
}

const inDrawnWindow = (id) => (lastSubgraph?.nodes || []).some((node) => node.id === id);

function renderSearchResults(result, query) {
  const nodes = result.nodes || [];
  const relTypes = result.relTypes || [];
  el.graphSearchClear.toggleAttribute("hidden", !query);
  if (!query) {
    el.graphSearchResults.replaceChildren();
    el.graphSearchResults.toggleAttribute("hidden", true);
    el.graphSearchStatus.textContent = "";
    return;
  }
  const counts = [
    `${nodes.length}${result.truncated ? "+" : ""} entit${nodes.length === 1 ? "y" : "ies"}`,
    relTypes.length ? `${relTypes.length} link type${relTypes.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  el.graphSearchStatus.textContent = nodes.length || relTypes.length ? counts : "no match";
  const items = [];
  for (const type of relTypes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "graph-search-hit link-type";
    item.textContent = `link: ${type.toLowerCase().replace(/_/g, " ")}`;
    // A link type is not a place to centre on: it filters the drawn edges.
    item.addEventListener("click", () => {
      matchedRelTypes = new Set([type]);
      matchedIds = new Set();
      applyMatchHighlight();
      el.graphSearchResults.toggleAttribute("hidden", true);
    });
    items.push(item);
  }
  for (const node of nodes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "graph-search-hit";
    const owner = config?.admin && node.owner ? ` · ${node.owner}` : "";
    item.textContent = `${node.name}${node.type ? ` · ${node.type}` : ""}${owner}`;
    item.addEventListener("click", () => {
      el.graphSearch.value = node.name;
      el.graphSearchResults.toggleAttribute("hidden", true);
      // Centre the drawing on the hit, and keep it highlighted there.
      matchedIds = new Set([node.id]);
      matchedRelTypes = new Set();
      focusLoadedFor = node.id;
      loadGraph(node.id).then(applyMatchHighlight);
    });
    items.push(item);
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "graph-search-empty";
    empty.textContent = `Nothing matches “${query}”.`;
    items.push(empty);
  }
  el.graphSearchResults.replaceChildren(...items);
  el.graphSearchResults.toggleAttribute("hidden", false);
}

async function runSearch(query) {
  const sequence = ++searchSequence;
  if (!query.trim()) {
    matchedIds = new Set();
    matchedRelTypes = new Set();
    renderSearchResults({ nodes: [], relTypes: [] }, "");
    applyMatchHighlight();
    // A search focus may have swapped the drawn window to one entity's
    // neighbourhood (a lone hit fetched, or a result clicked); clearing the
    // query restores the initial objects, not just the highlight and the
    // camera. loadGraph(null) also resets graphCenter, so the 15 s poll stops
    // re-fetching the neighbourhood.
    if (focusLoadedFor) {
      focusLoadedFor = null;
      loadGraph(null);
    }
    return;
  }
  el.graphSearchStatus.textContent = "searching…";
  let result;
  try {
    result = await (await fetch(`/api/graph/search?q=${encodeURIComponent(query)}&limit=25`, { cache: "no-store" })).json();
  } catch (error) {
    el.graphSearchStatus.textContent = `search failed: ${error.message}`;
    return;
  }
  // A slower earlier request must not overwrite a newer one's results.
  if (sequence !== searchSequence) return;
  if (result.error) {
    el.graphSearchStatus.textContent = result.message || result.error;
    return;
  }
  // Highlight every hit that happens to be in the drawn window; the rest are
  // reachable by clicking a result.
  matchedIds = new Set((result.nodes || []).map((node) => node.id));
  matchedRelTypes = new Set(result.relTypes || []);
  renderSearchResults(result, query);
  // The search covers the whole graph, the drawing only a window of it: a lone
  // hit from outside that window has to be fetched before the camera can
  // centre on it. Guarded so a pause in typing does not refetch the same node.
  const single = singleMatchId();
  if (single && !inDrawnWindow(single) && focusLoadedFor !== single) {
    focusLoadedFor = single;
    await loadGraph(single);
  }
  applyMatchHighlight();
}

el.graphSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = el.graphSearch.value;
  // Debounced: one request per pause in typing, not per keystroke.
  searchTimer = setTimeout(() => runSearch(query), 250);
});

el.graphSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    el.graphSearch.value = "";
    clearTimeout(searchTimer);
    runSearch("");
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    el.graphSearchResults.querySelector(".graph-search-hit")?.click();
  }
});

el.graphSearchClear.addEventListener("click", () => {
  el.graphSearch.value = "";
  clearTimeout(searchTimer);
  runSearch("");
  el.graphSearch.focus();
});

async function start() {
  let response;
  try {
    response = await fetch("/api/config", { cache: "no-store" });
  } catch (error) {
    el.graphStatus.textContent = `Backend unreachable: ${error.message}`;
    return;
  }
  // The session lives in the shared cookie: a signed-out tab gets the same
  // 403 the app uses to mean "show the login form".
  if (response.status === 403) {
    el.graphStatus.textContent = "Not signed in";
    el.graphHint.textContent = "Sign in on the Jarvis page first, then reload this tab.";
    return;
  }
  config = await response.json();
  el.graphUser.textContent = config.admin ? `${config.user} · admin (all users)` : `${config.user}`;
  if (!config.graphConfigured) {
    el.graphStatus.textContent = "Not configured on this server";
    el.graphHint.textContent = "The backend has no NEO4J_* settings, so there is no graph to show.";
    return;
  }
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(sizesStorageKey) || "null");
    if (!saved || typeof saved !== "object") {
      saved = JSON.parse(localStorage.getItem(legacySizesStorageKey) || "null");
    }
  } catch {
    // Unreadable storage: fall back to this view's 150% default.
  }
  const edgeValue = Number(saved?.edgeBrightness);
  el.graphEdgeBrightness.value = String(Number.isFinite(edgeValue) && edgeValue >= 30 && edgeValue <= 200 ? edgeValue : 100);
  const limitValue = Number(saved?.entityLimit);
  pendingGraphEntityLimit = Number.isFinite(limitValue) && limitValue >= GRAPH_ENTITY_LIMIT_MIN ? Math.round(limitValue) : 200;
  el.graphEntityLimit.value = String(pendingGraphEntityLimit);
  for (const [key, slider] of [["node", el.graphNodeSize], ["text", el.graphTextSize]]) {
    const value = Number(saved?.[key]);
    slider.value = String(Number.isFinite(value) && value >= 50 && value <= 300 ? value : DEFAULT_SCALE_PERCENT);
  }
  graphDisplay.edgeBrightness = Number(el.graphEdgeBrightness.value) / 100;
  graphDisplay.entityLimit = Number(el.graphEntityLimit.value);
  graphDisplay.node = Number(el.graphNodeSize.value) / 100;
  graphDisplay.text = Number(el.graphTextSize.value) / 100;
  applyGraphScales();
  el.graphRefreshButton.disabled = false;
  setGraphView("3d");
  await loadGraph();
  setInterval(() => { if (!document.hidden) loadGraph(); }, 15000);
}

start();
