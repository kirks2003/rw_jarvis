// The Kandev MCP names every tool with a redundant "_kandev" suffix
// (list_workspaces_kandev, create_task_kandev, ...). The backend namespaces
// external tools as "<id>_<tool>", so that becomes
// "kandev-nbg_list_workspaces_kandev" — a double "kandev". The brain
// "cleans" the redundant suffix and calls "kandev-nbg_list_workspaces", a
// name the dispatch can't find, and answers "Unknown tool". The clean display
// name drops the redundant suffix for kandev servers only; the dispatch still
// uses the original tool name for the actual MCP call.
function externalToolDisplayName(entryId, toolName) {
  const id = String(entryId || "");
  const name = String(toolName || "");
  if (id.startsWith("kandev") && name.endsWith("_kandev")) {
    return name.slice(0, -"_kandev".length);
  }
  return name;
}

module.exports = { externalToolDisplayName };
