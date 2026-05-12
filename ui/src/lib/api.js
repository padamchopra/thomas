export async function fetchState() {
  const data = await request("/api/state");
  return data.state;
}

export async function createProject(payload) {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateProject(projectId, payload) {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function chooseProjectFolder() {
  return request("/api/projects/choose-folder", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createAgent(payload) {
  return request("/api/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createTicket(payload) {
  return request("/api/tickets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTicket(ticketId, payload) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteTicket(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}`, {
    method: "DELETE",
  });
}

export async function dispatchTicket(ticketId, payload = {}) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/dispatch`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function stopTicketRun(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function refreshTicketStatus(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/refresh-status`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function runTicketSetupScript(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/run-setup-script`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function updateSettings(payload) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function fetchTicketDiff(ticketId) {
  const data = await request(`/api/tickets/${encodeURIComponent(ticketId)}/diff`);
  return data.diff;
}

export async function fetchTicketPlans(ticketId, planPath = "") {
  const query = planPath ? `?path=${encodeURIComponent(planPath)}` : "";
  const data = await request(`/api/tickets/${encodeURIComponent(ticketId)}/plans${query}`);
  return data.plans;
}

export async function createTicketPlan(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/plans`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function addPlanComment(ticketId, payload) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/plan-comments`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updatePlanComment(ticketId, commentId, payload) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/plan-comments/${encodeURIComponent(commentId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function openTicketFile(ticketId, filePath) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/open-file`, {
    method: "POST",
    body: JSON.stringify({ filePath }),
  });
}

export async function openTicketWorktree(ticketId) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/open-worktree`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function resumeTicketTerminal(ticketId, terminal) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/resume-terminal`, {
    method: "POST",
    body: JSON.stringify(terminal ? { terminal } : {}),
  });
}

export async function addComment(ticketId, payload) {
  return request(`/api/tickets/${encodeURIComponent(ticketId)}/comments`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", "x-thomas-actor": "ui" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}
