// utils/dashboardLinks.js
//
// Maps a SUCCESSFUL assistant tool result to the dashboard page where the
// user can see what was just created. Used on the WhatsApp channel, where the
// reply is plain text: the server appends the link itself (deterministically)
// instead of trusting the model to remember to include one.
//
// Paths match the frontend routes in src/App.jsx.

const LINKS = {
  create_group_from_upload: (r) => ({
    label: "Open your group",
    path: r?.group_id ? `/dashboard/${r.group_id}` : "/groups",
  }),
  create_group_from_sheet: (r) => ({
    label: "Open your group",
    path: r?.group_id ? `/dashboard/${r.group_id}` : "/groups",
  }),
  create_template: (r) => ({ label: "See the template", path: "/templates" }),
  create_campaign: (r) => ({
    label: "See the campaign",
    path: r?.campaign_id ? `/campaigns/${r.campaign_id}` : "/campaigns",
  }),
  create_flow: (r) => ({
    label: "Open the flow",
    path: r?.flow_id ? `/chatbot/builder/${r.flow_id}` : "/chatbot",
  }),
  create_agent: (r) => ({ label: "See the agent", path: "/agents" }),
};

/** { label, path } for a successful create_* tool result, otherwise null. */
export function dashboardLinkForResult(toolName, result) {
  if (!result || result.error || result.success !== true) return null;
  const build = LINKS[toolName];
  return build ? build(result) : null;
}

/** Turns collected links into "label: url" lines (empty if no base URL). */
export function formatDashboardLinks(links, baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base || !Array.isArray(links) || links.length === 0) return "";
  const seen = new Set();
  const lines = [];
  for (const l of links) {
    if (!l?.path || seen.has(l.path)) continue;
    seen.add(l.path);
    lines.push(`${l.label}: ${base}${l.path}`);
  }
  return lines.join("\n");
}
