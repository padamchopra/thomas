"use strict";

const { PRIORITIES, STATUS_LABELS, TICKET_STATUSES } = require("./schema");
const { createStateStore } = require("./state-store");

function createThomasService(options = {}) {
  const store = options.store || createStateStore(options);

  function mutate(actor, type, subject, fn) {
    const state = store.load();
    const result = fn(state);
    state.updatedAt = new Date().toISOString();
    if (!result?.skipActivity) {
      addActivity(state, actor, type, subject, result?.activityDetails || {});
    }
    store.save(state);
    return result?.value === undefined ? result : result.value;
  }

  return {
    statePath: store.path,

    getState() {
      const state = store.load();
      return presentState(state, store.path);
    },

    recoverInterruptedRuns() {
      const state = store.load();
      const interrupted = state.tickets.filter((ticket) => ticket.status === "in_progress");
      if (!interrupted.length) return 0;
      const now = new Date().toISOString();
      for (const ticket of interrupted) {
        ticket.status = "human_review";
        ticket.updatedAt = now;
        state.comments.push({
          id: nextId(state, "comment", "comment"),
          ticketId: ticket.id,
          author: "agent",
          body: "Thomas restarted while this ticket was in development, so the agent process is no longer attached. Any captured transcript remains available from the run log; review the current workspace state, then comment again if the agent should continue.",
          metadata: { type: "agent_run_interrupted" },
          createdAt: now,
          updatedAt: now,
        });
      }
      state.updatedAt = now;
      addActivity(state, "agent", "agent.run.interrupted", "tickets", {
        ticketIds: interrupted.map((ticket) => ticket.id),
      });
      store.save(state);
      return interrupted.length;
    },

    updateSettings(input, actor = "api") {
      return mutate(actor, "settings.updated", "settings", (state) => {
        const before = { ...state.settings };
        state.settings = {
          ...state.settings,
          ...(input.theme !== undefined ? { theme: normalizeTheme(input.theme) } : {}),
          ...(input.notifyHumanReview !== undefined ? { notifyHumanReview: input.notifyHumanReview === true } : {}),
          ...(input.showLiveAgentActivity !== undefined ? { showLiveAgentActivity: input.showLiveAgentActivity !== false } : {}),
          ...(input.preferredTerminal !== undefined ? { preferredTerminal: normalizeTerminal(input.preferredTerminal) } : {}),
        };
        return { value: state.settings, activityDetails: { changed: changedKeys(before, state.settings) } };
      });
    },

    createProject(input, actor = "api") {
      return mutate(actor, "project.created", null, (state) => {
        const name = requireString(input.name, "name");
        if (state.projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
          throw httpError(409, `Project already exists: ${name}`);
        }
        const now = new Date().toISOString();
        const project = {
          id: nextId(state, "project", "project"),
          name,
          prefix: normalizePrefix(input.prefix || name),
          repoPath: input.repoPath || "",
          description: input.description || "",
          setupScript: input.setupScript || "",
          nextTicketNumber: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.projects.push(project);
        return { value: project, activityDetails: { projectId: project.id } };
      });
    },

    createAgent(input, actor = "api") {
      return mutate(actor, "agent.created", null, (state) => {
        const name = requireString(input.name, "name");
        const now = new Date().toISOString();
        const agent = {
          id: nextId(state, "agent", "agent"),
          name,
          type: input.type || "custom",
          command: input.command || "",
          status: input.status || "available",
          createdAt: now,
          updatedAt: now,
        };
        state.agents.push(agent);
        return { value: agent, activityDetails: { agentId: agent.id } };
      });
    },

    createTicket(input, actor = "api") {
      return mutate(actor, "ticket.created", null, (state) => {
        const project = findProject(state, input.projectId || input.project);
        const title = requireString(input.title, "title");
        const status = normalizeStatus(input.status || "todo");
        const priority = normalizePriority(input.priority || "medium");
        const now = new Date().toISOString();
        const number = project.nextTicketNumber;
        project.nextTicketNumber += 1;
        project.updatedAt = now;

        const parentTicketId = input.parentTicketId || null;
        if (parentTicketId) requireTicket(state, parentTicketId);

        const blockedByTicketIds = normalizeTicketIds(state, input.blockedByTicketIds || []);
        const ticketStatus = blockedByTicketIds.length > 0 && status !== "done" ? "blocked" : status;
        const ticket = {
          id: `${project.prefix}-${number}`,
          number,
          projectId: project.id,
          title,
          description: input.description || "",
          status: ticketStatus,
          priority,
          assigneeAgentId: input.assigneeAgentId || null,
          parentTicketId,
          blockedByTicketIds,
          labels: Array.isArray(input.labels) ? input.labels.map(String).filter(Boolean) : [],
          workspaceId: input.workspaceId || null,
          prUrl: input.prUrl || null,
          createdAt: now,
          updatedAt: now,
        };
        if (ticket.assigneeAgentId) requireAgent(state, ticket.assigneeAgentId);
        state.tickets.push(ticket);
        assertNoCircularBlockers(state, ticket.id, blockedByTicketIds);
        return { value: ticket, activityDetails: { ticketId: ticket.id } };
      });
    },

    updateTicket(ticketId, input, actor = "api") {
      return mutate(actor, "ticket.updated", ticketId, (state) => {
        const ticket = requireTicket(state, ticketId);
        const before = { ...ticket };
        if (input.title !== undefined) ticket.title = requireString(input.title, "title");
        if (input.description !== undefined) ticket.description = String(input.description || "");
        const statusChangedToDone = input.status !== undefined && normalizeStatus(input.status) === "done";
        if (input.status !== undefined) {
          if (actor === "ui") throw httpError(400, "Ticket status is controlled by the agent workflow.");
          ticket.status = normalizeStatus(input.status);
        }
        if (input.priority !== undefined) ticket.priority = normalizePriority(input.priority);
        if (input.assigneeAgentId !== undefined) {
          ticket.assigneeAgentId = input.assigneeAgentId || null;
          if (ticket.assigneeAgentId) requireAgent(state, ticket.assigneeAgentId);
        }
        if (input.parentTicketId !== undefined) {
          ticket.parentTicketId = input.parentTicketId || null;
          if (ticket.parentTicketId) {
            if (ticket.parentTicketId === ticket.id) throw httpError(400, "Ticket cannot be its own parent.");
            requireTicket(state, ticket.parentTicketId);
          }
        }
        if (input.blockedByTicketIds !== undefined) {
          ticket.blockedByTicketIds = normalizeTicketIds(state, input.blockedByTicketIds);
          assertNoCircularBlockers(state, ticket.id, ticket.blockedByTicketIds);
          if (ticket.blockedByTicketIds.length > 0 && ticket.status !== "done") {
            ticket.status = "blocked";
          }
        }
        if (input.labels !== undefined) {
          ticket.labels = Array.isArray(input.labels) ? input.labels.map(String).filter(Boolean) : [];
        }
        if (input.prUrl !== undefined) ticket.prUrl = input.prUrl || null;
        if (ticket.status === "done") {
          trimDoneTicketState(state, ticket.id);
        }
        ticket.updatedAt = new Date().toISOString();
        return {
          value: ticket,
          activityDetails: { ticketId: ticket.id, changed: changedKeys(before, ticket) },
          skipActivity: ticket.status === "done" || statusChangedToDone,
        };
      });
    },

    deleteTicket(ticketId, actor = "api") {
      return mutate(actor, "ticket.deleted", ticketId, (state) => {
        const ticket = requireTicket(state, ticketId);
        state.tickets = state.tickets.filter((item) => item.id !== ticket.id);
        state.comments = state.comments.filter((comment) => comment.ticketId !== ticket.id);
        state.activity = state.activity.filter((event) => event.subject !== ticket.id && event.details?.ticketId !== ticket.id);
        for (const other of state.tickets) {
          if (other.parentTicketId === ticket.id) other.parentTicketId = null;
          if (Array.isArray(other.blockedByTicketIds)) {
            other.blockedByTicketIds = other.blockedByTicketIds.filter((id) => id !== ticket.id);
          }
        }
        return { value: ticket, skipActivity: true };
      });
    },

    addComment(ticketId, input, actor = "api") {
      return mutate(actor, "comment.created", ticketId, (state) => {
        const ticket = requireTicket(state, ticketId);
        const body = requireString(input.body, "body");
        const now = new Date().toISOString();
        const comment = {
          id: nextId(state, "comment", "comment"),
          ticketId: ticket.id,
          author: normalizeCommentAuthor(input.author || actor),
          body,
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
          createdAt: now,
          updatedAt: now,
        };
        state.comments.push(comment);
        ticket.updatedAt = now;
        return { value: comment, activityDetails: { ticketId: ticket.id, commentId: comment.id } };
      });
    },

    assignTicket(ticketId, agentId, actor = "api") {
      return this.updateTicket(ticketId, { assigneeAgentId: agentId || null }, actor);
    },

    setBlockers(ticketId, blockedByTicketIds, actor = "api") {
      return this.updateTicket(ticketId, { blockedByTicketIds }, actor);
    },

    recordActivity(type, subject, details = {}, actor = "agent") {
      return mutate(actor, type, subject, () => ({ value: true, activityDetails: details }));
    },
  };
}

function presentState(state, statePath) {
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
  const commentsByTicket = groupBy(state.comments, "ticketId");
  const tickets = state.tickets.map((ticket) => {
    const children = state.tickets.filter((candidate) => candidate.parentTicketId === ticket.id);
    const blocks = state.tickets.filter((candidate) => candidate.blockedByTicketIds.includes(ticket.id));
    const { priority, ...visibleTicket } = ticket;
    return {
      ...visibleTicket,
      statusLabel: STATUS_LABELS[ticket.status] || ticket.status,
      project: projectsById.get(ticket.projectId) || null,
      assignee: ticket.assigneeAgentId ? agentsById.get(ticket.assigneeAgentId) || null : null,
      comments: commentsByTicket.get(ticket.id) || [],
      children: children.map((item) => summarizeTicket(item)),
      blockedBy: ticket.blockedByTicketIds.map((id) => summarizeTicket(state.tickets.find((item) => item.id === id))).filter(Boolean),
      blocks: blocks.map((item) => summarizeTicket(item)),
    };
  });
  return {
    version: state.version,
    generatedAt: new Date().toISOString(),
    statePath,
    statuses: TICKET_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
    settings: state.settings,
    projects: state.projects,
    agents: state.agents,
    tickets,
    activity: state.activity.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    stats: buildStats(tickets, state.agents),
  };
}

function buildStats(tickets, agents) {
  const byStatus = Object.fromEntries(TICKET_STATUSES.map((status) => [status, 0]));
  for (const ticket of tickets) byStatus[ticket.status] = (byStatus[ticket.status] || 0) + 1;
  return {
    totalTickets: tickets.length,
    openTickets: tickets.filter((ticket) => !["done", "cancelled"].includes(ticket.status)).length,
    unassignedTodo: tickets.filter((ticket) => ticket.status === "todo" && !ticket.assigneeAgentId).length,
    blocked: byStatus.blocked || 0,
    inProgress: byStatus.in_progress || 0,
    done: byStatus.done || 0,
    activeAgents: agents.filter((agent) => agent.status !== "paused").length,
    byStatus,
  };
}

function summarizeTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    assigneeAgentId: ticket.assigneeAgentId || null,
  };
}

function addActivity(state, actor, type, subject, details = {}) {
  const now = new Date().toISOString();
  state.activity.push({
    id: nextId(state, "activity", "activity"),
    type,
    actor: actor || "api",
    subject: subject || details.ticketId || details.projectId || details.agentId || null,
    details,
    createdAt: now,
  });
}

function nextId(state, counter, prefix) {
  const value = state.counters[counter] || 1;
  state.counters[counter] = value + 1;
  return `${prefix}-${value}`;
}

function findProject(state, value) {
  if (!value && state.projects.length === 1) return state.projects[0];
  const input = String(value || "").trim();
  const project = state.projects.find((item) =>
    item.id === input || item.name.toLowerCase() === input.toLowerCase() || item.prefix.toLowerCase() === input.toLowerCase()
  );
  if (!project) throw httpError(404, input ? `Unknown project: ${input}` : "Project is required.");
  return project;
}

function requireAgent(state, id) {
  const agent = state.agents.find((item) => item.id === id);
  if (!agent) throw httpError(404, `Unknown agent: ${id}`);
  return agent;
}

function requireTicket(state, id) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) throw httpError(404, `Unknown ticket: ${id}`);
  return ticket;
}

function normalizeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!TICKET_STATUSES.includes(normalized)) {
    throw httpError(400, `Unknown status: ${status}`);
  }
  return normalized;
}

function normalizePriority(priority) {
  const normalized = String(priority || "").trim().toLowerCase();
  if (!PRIORITIES.includes(normalized)) throw httpError(400, `Unknown priority: ${priority}`);
  return normalized;
}

function normalizeTheme(theme) {
  const normalized = String(theme || "").trim().toLowerCase();
  if (!["system", "dark", "light"].includes(normalized)) throw httpError(400, `Unknown theme: ${theme}`);
  return normalized;
}

function normalizeTerminal(terminal) {
  const normalized = String(terminal || "").trim().toLowerCase();
  if (!["warp", "terminal", "iterm", "system"].includes(normalized)) throw httpError(400, `Unknown terminal: ${terminal}`);
  return normalized;
}

function normalizePrefix(value) {
  const prefix = String(value || "PROJ").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!prefix) return "PROJ";
  return /^[A-Z]/.test(prefix) ? prefix : `P${prefix}`;
}

function normalizeTicketIds(state, ids) {
  if (!Array.isArray(ids)) throw httpError(400, "blockedByTicketIds must be an array.");
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  for (const id of unique) requireTicket(state, id);
  return unique;
}

function assertNoCircularBlockers(state, ticketId, blockerIds) {
  if (blockerIds.includes(ticketId)) throw httpError(400, "Ticket cannot block itself.");
  const visited = new Set();
  const walk = (id) => {
    if (id === ticketId) throw httpError(400, "Circular blocker relationship rejected.");
    if (visited.has(id)) return;
    visited.add(id);
    const ticket = state.tickets.find((item) => item.id === id);
    for (const blockerId of ticket?.blockedByTicketIds || []) walk(blockerId);
  };
  for (const blockerId of blockerIds) walk(blockerId);
}

function requireString(value, field) {
  const result = String(value || "").trim();
  if (!result) throw httpError(400, `${field} is required.`);
  return result;
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

function changedKeys(before, after) {
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function normalizeCommentAuthor(author) {
  const normalized = String(author || "").trim().toLowerCase();
  if (normalized === "agent" || normalized === "assistant" || normalized === "bot") return "agent";
  return "you";
}

function trimDoneTicketState(state, ticketId) {
  const ticket = requireTicket(state, ticketId);
  ticket.parentTicketId = null;
  ticket.blockedByTicketIds = [];
  ticket.labels = [];
  ticket.workspaceId = null;
  state.comments = state.comments.filter((comment) => comment.ticketId !== ticketId);
  state.activity = state.activity.filter((event) => event.subject !== ticketId && event.details?.ticketId !== ticketId);
  for (const other of state.tickets) {
    if (other.id === ticketId) continue;
    if (other.parentTicketId === ticketId) other.parentTicketId = null;
    if (Array.isArray(other.blockedByTicketIds)) {
      other.blockedByTicketIds = other.blockedByTicketIds.filter((id) => id !== ticketId);
    }
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  createThomasService,
  httpError,
};
