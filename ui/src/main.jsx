import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronDown,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Columns3,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  ExternalLink,
  History,
  Inbox,
  LayoutDashboard,
  List,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  SquarePen,
  Settings,
  Tag,
  Terminal,
  Trash2,
  UsersRound,
  UserRound,
  X,
  FileDiff,
  FileText,
} from "lucide-react";
import { addComment, addPlanComment, chooseProjectFolder, createAgent, createProject, createTicket, createTicketPlan, deleteTicket, fetchState, fetchTicketDiff, fetchTicketPlans, openTicketFile, openTicketWorktree, refreshTicketStatus, resumeTicketTerminal, runTicketSetupScript, stopTicketRun, updatePlanComment, updateProject, updateSettings, updateTicket } from "./lib/api";
import {
  IssueRow,
  KanbanBoard,
  RunningElapsed,
  SidebarNavItem,
  SidebarSection,
  StatusIcon,
  timeAgo,
} from "./components/primitives";
import { Card } from "./components/ui";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Separator } from "./components/ui/separator";
import { Skeleton } from "./components/ui/skeleton";
import "./styles.css";

const BOARD_STATUSES = ["backlog", "todo", "in_progress", "blocked", "human_review", "pr_review", "done"];
const ROUTE_VIEWS = new Set(["dashboard", "inbox", "tickets", "projects", "agents", "activity", "settings"]);
const RESERVED_TOP_LEVEL = new Set([...ROUTE_VIEWS, "board", "list"]);
const TICKET_PRESET_LABELS = {
  in_flight: "In flight",
  needs_review: "Needs review",
  unassigned: "Unassigned",
  done: "Completed",
};
const TERMINAL_OPTIONS = [
  { value: "warp", label: "Warp" },
  { value: "terminal", label: "Terminal" },
  { value: "iterm", label: "iTerm" },
  { value: "system", label: "System" },
];

function projectPrefixFromTicketId(ticketId) {
  const parts = String(ticketId || "").split("-");
  return parts.length >= 2 ? parts.slice(0, -1).join("-") : "";
}

function readRoute() {
  if (typeof window === "undefined") return { view: "dashboard", ticketId: null, agentId: null, projectId: null, projectPrefix: null, layout: "board" };
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "tickets" && parts[1]) {
    const ticketId = decodeURIComponent(parts[1]);
    return { view: "projects", ticketId, agentId: null, projectId: null, projectPrefix: projectPrefixFromTicketId(ticketId), layout: "board" };
  }
  if (parts[0] === "tickets") {
    const layout = new URLSearchParams(window.location.search).get("layout") === "list" ? "list" : "board";
    return { view: "tickets", ticketId: null, agentId: null, projectId: null, projectPrefix: null, layout };
  }
  if (parts[0] === "projects" && parts[1]) {
    return { view: "projects", ticketId: null, agentId: null, projectId: decodeURIComponent(parts[1]), projectPrefix: null, layout: "board" };
  }
  if (parts[0] === "agents" && parts[1]) {
    return { view: "agents", ticketId: null, agentId: decodeURIComponent(parts[1]), projectId: null, projectPrefix: null, layout: "board" };
  }
  if (parts[0] === "board" || parts[0] === "list") {
    return { view: "tickets", ticketId: null, agentId: null, projectId: null, projectPrefix: null, layout: parts[0] };
  }
  if (ROUTE_VIEWS.has(parts[0])) {
    return { view: parts[0], ticketId: null, agentId: null, projectId: null, projectPrefix: null, layout: "board" };
  }
  if (parts.length >= 1 && !RESERVED_TOP_LEVEL.has(parts[0])) {
    const prefix = decodeURIComponent(parts[0]);
    if (parts[1] === "issue" && parts[2]) {
      return { view: "projects", ticketId: decodeURIComponent(parts[2]), agentId: null, projectId: null, projectPrefix: prefix, layout: "board" };
    }
    return { view: "projects", ticketId: null, agentId: null, projectId: null, projectPrefix: prefix, layout: "board" };
  }
  return { view: "dashboard", ticketId: null, agentId: null, projectId: null, projectPrefix: null, layout: "board" };
}

function pathForView(view, layout = "board") {
  if (view === "dashboard") return "/";
  if (view === "tickets") return `/tickets?layout=${layout === "list" ? "list" : "board"}`;
  return `/${ROUTE_VIEWS.has(view) ? view : ""}`;
}

function pathForProject(project) {
  if (!project) return "/projects";
  const prefix = String(project.prefix || project.id || "");
  if (!prefix) return "/projects";
  return `/${encodeURIComponent(prefix)}`;
}

function pathForTicket(ticketId, project) {
  const prefix = String(project?.prefix || projectPrefixFromTicketId(ticketId));
  if (!prefix) return `/tickets/${encodeURIComponent(ticketId)}`;
  return `/${encodeURIComponent(prefix)}/issue/${encodeURIComponent(ticketId)}`;
}

function pushPath(path, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  if (`${window.location.pathname}${window.location.search}` === path) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", path);
}

function App() {
  const initialRoute = useMemo(readRoute, []);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState(initialRoute.view);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("updated");
  const [groupBy, setGroupBy] = useState("status");
  const [ticketLayout, setTicketLayout] = useState(initialRoute.layout || "board");
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [ticketPresetFilter, setTicketPresetFilter] = useState("all");
  const [selectedTicketId, setSelectedTicketId] = useState(initialRoute.ticketId);
  const [selectedAgentId, setSelectedAgentId] = useState(initialRoute.agentId);
  const [selectedProjectId, setSelectedProjectId] = useState(initialRoute.projectId || null);
  const [pendingProjectPrefix, setPendingProjectPrefix] = useState(initialRoute.projectPrefix || null);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [ticketDraftDefaults, setTicketDraftDefaults] = useState({});
  const notifiedHumanReviewTicketIds = useRef(new Set());
  const notificationBaselineReady = useRef(false);

  const openNewTicket = (defaults = {}) => {
    setTicketDraftDefaults(defaults);
    setNewTicketOpen(true);
  };

  const closeNewTicket = () => {
    setNewTicketOpen(false);
    setTicketDraftDefaults({});
  };

  const openView = (nextView, options = {}) => {
    setSelectedTicketId(null);
    setSelectedAgentId(null);
    setSelectedProjectId(null);
    setPendingProjectPrefix(null);
    setView(nextView);
    pushPath(pathForView(nextView, ticketLayout), options);
  };

  const openTicketsWithPreset = (preset) => {
    setSelectedTicketId(null);
    setSelectedAgentId(null);
    setSelectedProjectId(null);
    setPendingProjectPrefix(null);
    setQuery("");
    setStatusFilter("all");
    setProjectFilter("all");
    setAssigneeFilter("all");
    setTicketPresetFilter(preset);
    setView("tickets");
    pushPath(pathForView("tickets", ticketLayout));
  };

  const openTicketsWithStatus = (status) => {
    setSelectedTicketId(null);
    setSelectedAgentId(null);
    setSelectedProjectId(null);
    setPendingProjectPrefix(null);
    setQuery("");
    setTicketPresetFilter("all");
    setProjectFilter("all");
    setAssigneeFilter("all");
    setStatusFilter(status);
    setView("tickets");
    pushPath(pathForView("tickets", ticketLayout));
  };

  const updateStatusFilter = (value) => {
    setTicketPresetFilter("all");
    setStatusFilter(value);
  };

  const updateProjectFilter = (value) => {
    setTicketPresetFilter("all");
    setProjectFilter(value);
  };

  const updateAssigneeFilter = (value) => {
    setTicketPresetFilter("all");
    setAssigneeFilter(value);
  };

  const changeTicketLayout = (layout) => {
    setTicketLayout(layout);
    if (view === "tickets" && !selectedTicketId) {
      pushPath(pathForView("tickets", layout));
    }
  };

  const openTicket = (ticketId, options = {}) => {
    const ticket = options.ticket || state?.tickets.find((item) => item.id === ticketId) || null;
    setSelectedTicketId(ticketId);
    setSelectedAgentId(null);
    const project = ticket ? state?.projects.find((item) => item.id === ticket.projectId) : null;
    pushPath(pathForTicket(ticketId, project), options);
    setSelectedProjectId(ticket?.projectId || null);
    setPendingProjectPrefix(null);
    if (ticket) setView("projects");
  };

  const openAgent = (agentId, options = {}) => {
    setSelectedTicketId(null);
    setSelectedAgentId(agentId);
    setSelectedProjectId(null);
    setPendingProjectPrefix(null);
    setView("agents");
    pushPath(`/agents/${encodeURIComponent(agentId)}`, options);
  };

  const openProject = (projectId, options = {}) => {
    const project = findProjectByIdentifier(state?.projects || [], projectId) || { id: projectId };
    setSelectedTicketId(null);
    setSelectedAgentId(null);
    setSelectedProjectId(project.id);
    setPendingProjectPrefix(null);
    setView("projects");
    pushPath(pathForProject(project), options);
  };

  const closeTicket = () => {
    const ticket = state?.tickets.find((item) => item.id === selectedTicketId);
    if (ticket) {
      openProject(ticket.projectId);
      return;
    }
    openView(view === "agents" ? "agents" : "tickets");
  };

  const refresh = async () => {
    try {
      setState(await fetchState());
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    registerThomasServiceWorker();
  }, []);

  useEffect(() => {
    if (window.location.pathname === "/dashboard") {
      pushPath("/", { replace: true });
    }
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const route = readRoute();
      setView(route.view);
      setSelectedTicketId(route.ticketId);
      setSelectedAgentId(route.agentId);
      setTicketLayout(route.layout || "board");
      if (route.projectPrefix) {
        setPendingProjectPrefix(route.projectPrefix);
      } else if (route.projectId) {
        setSelectedProjectId(route.projectId);
        setPendingProjectPrefix(null);
      } else {
        setSelectedProjectId(null);
        setPendingProjectPrefix(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!state || !pendingProjectPrefix) return;
    const needle = String(pendingProjectPrefix).toLowerCase();
    const project = state.projects.find((item) => String(item.prefix || "").toLowerCase() === needle);
    if (project) {
      setSelectedProjectId(project.id);
    }
    setPendingProjectPrefix(null);
  }, [state, pendingProjectPrefix]);

  useEffect(() => {
    if (!state) return;
    notifyHumanReviewTickets(state, notifiedHumanReviewTicketIds.current, notificationBaselineReady);
  }, [state]);

  const selectedTicket = useMemo(
    () => state?.tickets.find((ticket) => ticket.id === selectedTicketId) || null,
    [state, selectedTicketId],
  );
  const selectedAgent = useMemo(
    () => state?.agents.find((agent) => agent.id === selectedAgentId) || null,
    [state, selectedAgentId],
  );
  const selectedProject = useMemo(
    () => findProjectByIdentifier(state?.projects || [], selectedProjectId),
    [state, selectedProjectId],
  );
  const openTicketCount = state?.tickets.filter((ticket) => !["done", "cancelled"].includes(ticket.status)).length || 0;
  const inboxCount = state?.tickets.filter((ticket) =>
    ticket.status === "blocked" ||
    ["human_review", "pr_review"].includes(ticket.status) ||
    (ticket.status === "todo" && !ticket.assigneeAgentId),
  ).length || 0;
  const activeBoardCount = state?.tickets.filter((ticket) => ["todo", "in_progress", "blocked", "human_review", "pr_review"].includes(ticket.status)).length || 0;
  const agentOpenCounts = useMemo(() => {
    const counts = new Map();
    for (const ticket of state?.tickets || []) {
      if (!ticket.assigneeAgentId || ["done", "cancelled"].includes(ticket.status)) continue;
      counts.set(ticket.assigneeAgentId, (counts.get(ticket.assigneeAgentId) || 0) + 1);
    }
    return counts;
  }, [state]);
  const projectOpenCounts = useMemo(() => {
    const counts = new Map();
    for (const ticket of state?.tickets || []) {
      if (["done", "cancelled"].includes(ticket.status)) continue;
      counts.set(ticket.projectId, (counts.get(ticket.projectId) || 0) + 1);
    }
    return counts;
  }, [state]);
  const headerTitle = selectedTicket ? selectedTicket.id : selectedAgent && view === "agents" ? selectedAgent.name : selectedProject && view === "projects" ? selectedProject.name : viewTitle(view);
  const headerSubtitle = selectedTicket
    ? `${selectedTicket.statusLabel} · ${selectedTicket.project?.name || "Unknown project"} · updated ${timeAgo(selectedTicket.updatedAt)}`
    : selectedAgent && view === "agents"
      ? `${selectedAgent.type} · ${selectedAgent.status} · ${agentOpenCounts.get(selectedAgent.id) || 0} open tickets`
    : selectedProject && view === "projects"
      ? `${projectOpenCounts.get(selectedProject.id) || 0} open tickets · ${selectedProject.prefix}`
    : `${state?.stats.openTickets || 0} open tickets · ${state?.stats.activeAgents || 0} agents · ${state?.stats.unassignedTodo || 0} unassigned to-do`;
  const isDashboardHome = !selectedTicket && view === "dashboard";

  const filteredTickets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let tickets = state?.tickets || [];
    if (statusFilter !== "all") tickets = tickets.filter((ticket) => ticket.status === statusFilter);
    if (projectFilter !== "all") tickets = tickets.filter((ticket) => ticket.projectId === projectFilter);
    if (assigneeFilter === "unassigned") tickets = tickets.filter((ticket) => !ticket.assigneeAgentId);
    if (assigneeFilter !== "all" && assigneeFilter !== "unassigned") {
      tickets = tickets.filter((ticket) => ticket.assigneeAgentId === assigneeFilter);
    }
    if (ticketPresetFilter !== "all") {
      tickets = tickets.filter((ticket) => ticketMatchesPreset(ticket, state?.runs || [], ticketPresetFilter));
    }
    if (needle) {
      tickets = tickets.filter((ticket) =>
        [ticket.id, ticket.title, ticket.description, ticket.project?.name, ticket.assignee?.name, ticket.statusLabel]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
      );
    }
    return [...tickets].sort((a, b) => compareTickets(a, b, sortBy));
  }, [state, query, sortBy, statusFilter, projectFilter, assigneeFilter, ticketPresetFilter]);

  const handleCreateProject = async (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    try {
      const form = new FormData(target);
      await createProject({
        name: form.get("name"),
        prefix: form.get("prefix"),
        repoPath: form.get("repoPath"),
        setupScript: form.get("setupScript"),
      });
      target.reset();
      openView("tickets");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpdateProject = async (projectId, payload) => {
    try {
      await updateProject(projectId, payload);
      await refresh();
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  const handleCreateTicket = async (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    try {
      const form = new FormData(target);
      const assigneeAgentId = form.get("assigneeAgentId") || null;
      const response = await createTicket({
        projectId: form.get("projectId"),
        title: form.get("title"),
        description: form.get("description"),
        assigneeAgentId,
        parentTicketId: form.get("parentTicketId") || null,
      });
      target.reset();
      await refresh();
      closeNewTicket();
      openTicket(response.ticket.id, { ticket: response.ticket });
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreateAgent = async (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    try {
      const form = new FormData(target);
      await createAgent({
        name: form.get("name"),
        type: form.get("type"),
        command: form.get("command"),
        status: form.get("status"),
      });
      target.reset();
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTicketPatch = async (ticketId, patch) => {
    await updateTicket(ticketId, patch);
    await refresh();
  };

  const handleDeleteTicket = async (ticketId) => {
    const confirmed = window.confirm(`Delete ${ticketId}? This removes the ticket, comments, run logs, and any Thomas-owned worktree.`);
    if (!confirmed) return;
    try {
      await deleteTicket(ticketId);
      openView("tickets", { replace: true });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleStopTicketRun = async (ticketId) => {
    try {
      await stopTicketRun(ticketId);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRefreshTicketStatus = async (ticketId) => {
    try {
      await refreshTicketStatus(ticketId);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRunTicketSetupScript = async (ticketId) => {
    try {
      const result = await runTicketSetupScript(ticketId);
      await refresh();
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  const handleOpenTicketWorktree = async (ticketId) => {
    try {
      await openTicketWorktree(ticketId);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResumeTicketTerminal = async (ticketId, terminal) => {
    try {
      await resumeTicketTerminal(ticketId, terminal);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSettingsPatch = async (patch) => {
    try {
      const data = await updateSettings(patch);
      if (data?.state) setState(data.state);
      else await refresh();
      setError("");
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  if (!state) {
    return <Shell error={error}><AppSkeleton /></Shell>;
  }

  return (
    <Shell error={error} theme={state.settings?.theme || "system"}>
      <aside className={mobileSidebarOpen ? "side-pane mobile-open" : "side-pane"}>
        <div className="instance-header">
          <div className="instance-mark">T</div>
          <div>
            <strong>Thomas</strong>
            <span>Local control plane</span>
          </div>
          <button type="button" className="mobile-sidebar-close" onClick={() => setMobileSidebarOpen(false)} aria-label="Close navigation">
            <X />
          </button>
        </div>
        <nav className="command-nav" onClick={() => setMobileSidebarOpen(false)}>
          <Button variant="ghost" className="create-ticket-link" onClick={() => state.projects.length > 0 ? openNewTicket() : openView("projects")}><SquarePen /> New Ticket</Button>
          <SidebarSection label="Work">
            <SidebarNavItem active={view === "dashboard"} onClick={() => openView("dashboard")} icon={LayoutDashboard} label="Dashboard" />
            <SidebarNavItem active={view === "inbox"} onClick={() => openView("inbox")} icon={Inbox} label="Inbox" badge={inboxCount || null} />
            <SidebarNavItem active={view === "tickets"} onClick={() => openView("tickets")} icon={Columns3} label="Tickets" />
          </SidebarSection>
          <SidebarSection label="Projects">
            <SidebarNavItem active={view === "projects" && !selectedProjectId} onClick={() => openView("projects")} icon={FolderGit2} label="All Projects" />
            {state.projects.map((project) => (
              <Button
                variant="ghost"
                className={view === "projects" && selectedProject?.id === project.id ? "teammate-row active" : "teammate-row"}
                key={project.id}
                onClick={() => openProject(project.id)}
              >
                <span className="project-initial">{project.name.slice(0, 1).toUpperCase()}</span>
                <span>{project.name}</span>
                {(projectOpenCounts.get(project.id) || 0) > 0 ? <span className="sidebar-count">{projectOpenCounts.get(project.id)}</span> : null}
              </Button>
            ))}
          </SidebarSection>
          <SidebarSection label="Team">
            <SidebarNavItem active={view === "agents" && !selectedAgentId} onClick={() => openView("agents")} icon={UsersRound} label="Agents" />
            {state.agents.map((agent) => (
              <Button
                variant="ghost"
                className={view === "agents" && selectedAgentId === agent.id ? "teammate-row active" : "teammate-row"}
                key={agent.id}
                onClick={() => openAgent(agent.id)}
              >
                <span className={`presence-dot agent-${agent.status}`} />
                <span>{agent.name}</span>
                {(agentOpenCounts.get(agent.id) || 0) > 0 ? <span className="sidebar-count">{agentOpenCounts.get(agent.id)}</span> : null}
              </Button>
            ))}
          </SidebarSection>
          <SidebarSection label="Instance">
            <SidebarNavItem active={view === "activity"} onClick={() => openView("activity")} icon={History} label="Activity" />
            <SidebarNavItem active={view === "settings"} onClick={() => openView("settings")} icon={Settings} label="Settings" />
          </SidebarSection>
        </nav>
      </aside>
      {mobileSidebarOpen ? <button type="button" className="mobile-sidebar-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-label="Close navigation" /> : null}

      <main className="content-stage">
        <header className={selectedTicket ? "page-header page-header-detail" : "page-header"}>
          <div className="page-title-row">
            <button type="button" className="mobile-sidebar-toggle" aria-label="Open navigation" onClick={() => setMobileSidebarOpen(true)}>
              <Menu />
            </button>
            <div>
              <h1>{headerTitle}</h1>
              {!isDashboardHome ? <p>{headerSubtitle}</p> : null}
            </div>
          </div>
          <div className="header-actions">
            {!selectedTicket && state.projects.length > 0 && ["dashboard", "inbox", "tickets"].includes(view) ? (
              <Button onClick={() => openNewTicket()}><SquarePen /> New Ticket</Button>
            ) : null}
            {!selectedTicket && !isDashboardHome && <div className="view-switch">
              <button className={view === "dashboard" ? "active" : ""} onClick={() => openView("dashboard")} title="Dashboard"><LayoutDashboard /></button>
              <button className={view === "inbox" ? "active" : ""} onClick={() => openView("inbox")} title="Inbox"><Inbox /></button>
              <button className={view === "tickets" ? "active" : ""} onClick={() => openView("tickets")} title="Tickets"><Columns3 /></button>
            </div>}
            {!isDashboardHome ? <label className="find-box">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tickets" />
            </label> : null}
          </div>
        </header>

        {selectedTicket ? (
          <TicketDetail
            state={state}
            ticket={selectedTicket}
            onClose={closeTicket}
            onOpenTicket={openTicket}
            onOpenProject={openProject}
            onPatch={handleTicketPatch}
            onDelete={handleDeleteTicket}
            onStopRun={handleStopTicketRun}
            onRefreshStatus={handleRefreshTicketStatus}
            onRunSetupScript={handleRunTicketSetupScript}
            onOpenWorktree={handleOpenTicketWorktree}
            onResumeTerminal={handleResumeTicketTerminal}
            onStateUpdate={setState}
            onComment={async (body, metadata = {}) => {
              await addComment(selectedTicket.id, { body, metadata });
              await refresh();
            }}
            onCreateSubIssue={() => openNewTicket({
              projectId: selectedTicket.projectId,
              parentTicketId: selectedTicket.id,
            })}
          />
        ) : (
          <>
            {view === "projects" && <ProjectsView state={state} selectedProjectId={selectedProjectId} onSelectProject={openProject} onBack={() => openView("projects")} onCreateProject={handleCreateProject} onUpdateProject={handleUpdateProject} onOpenTicket={openTicket} onNewTicket={openNewTicket} />}
            {view === "agents" && <AgentsView state={state} selectedAgentId={selectedAgentId} onSelectAgent={openAgent} onBack={() => openView("agents")} onCreateAgent={handleCreateAgent} onOpenTicket={openTicket} />}
            {view === "activity" && <ActivityView state={state} />}
            {view === "settings" && <SettingsView state={state} onUpdateSettings={handleSettingsPatch} />}
            {["dashboard", "inbox", "tickets"].includes(view) && state.projects.length === 0 && (
              <Onboarding onCreateProject={handleCreateProject} />
            )}
            {["dashboard", "inbox", "tickets"].includes(view) && state.projects.length > 0 && (
              <>
                {view === "tickets" && (
                  <IssueControls
                    state={state}
                    sortBy={sortBy}
                    layout={ticketLayout}
                    statusFilter={statusFilter}
                    projectFilter={projectFilter}
                    assigneeFilter={assigneeFilter}
                    presetFilter={ticketPresetFilter}
                    onSortBy={setSortBy}
                    onLayout={changeTicketLayout}
                    onStatusFilter={updateStatusFilter}
                    onProjectFilter={updateProjectFilter}
                    onAssigneeFilter={updateAssigneeFilter}
                    onPresetFilter={setTicketPresetFilter}
                    groupBy={groupBy}
                    onGroupBy={setGroupBy}
                    resultCount={filteredTickets.length}
                  />
                )}
                {view === "dashboard" && <Dashboard state={state} onOpenTicket={openTicket} onOpenTicketsPreset={openTicketsWithPreset} onOpenTicketsStatus={openTicketsWithStatus} onOpenAgent={openAgent} onOpenProject={openProject} />}
                {view === "inbox" && <InboxView state={state} onOpenTicket={openTicket} />}
                {view === "tickets" && ticketLayout === "board" && <Board state={state} tickets={filteredTickets} onOpenTicket={openTicket} />}
                {view === "tickets" && ticketLayout === "list" && <TicketList tickets={filteredTickets} runs={state.runs || []} groupBy={groupBy} onOpenTicket={openTicket} />}
              </>
            )}
          </>
        )}
      </main>
      {newTicketOpen && (
        <Modal title={ticketDraftDefaults.parentTicketId ? "New Sub-issue" : "New Ticket"} onClose={closeNewTicket}>
          <CreateTicket state={state} onSubmit={handleCreateTicket} compact defaults={ticketDraftDefaults} />
        </Modal>
      )}
    </Shell>
  );
}

function Shell({ children, error, theme = "system" }) {
  return (
    <div className="workspace-shell" data-theme={theme}>
      {children}
      {error ? <div className="error-toast">{error}</div> : null}
    </div>
  );
}

function AppSkeleton() {
  return (
    <>
      <aside className="side-pane">
        <div className="instance-header gap-2">
          <Skeleton className="size-[26px] rounded-md" />
          <div className="grid gap-1">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        </div>
        <nav className="command-nav">
          <Skeleton className="h-9 w-full" />
          <div className="grid gap-1.5 px-1">
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-7 w-full" />
            ))}
          </div>
          <div className="grid gap-1.5 px-1 pt-2">
            <Skeleton className="h-2.5 w-12" />
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-7 w-full" />
            ))}
          </div>
          <div className="grid gap-1.5 px-1 pt-2">
            <Skeleton className="h-2.5 w-10" />
            {Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} className="h-7 w-full" />
            ))}
          </div>
        </nav>
      </aside>
      <main className="content-stage">
        <header className="page-header">
          <div className="page-title-row">
            <div className="grid gap-1.5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
          <div className="header-actions">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-64" />
          </div>
        </header>
        <div className="grid gap-3 px-1 pt-1">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={idx} className="h-24 w-full" />
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid gap-2">
              {Array.from({ length: 4 }).map((_, idx) => (
                <Skeleton key={idx} className="h-16 w-full" />
              ))}
            </div>
            <div className="grid gap-2">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

function Stats({ stats }) {
  return (
    <Card as="section" className="compact-stats" aria-label="Ticket stats">
      <span><CircleDot /> <strong>{stats.openTickets}</strong> open</span>
      <span><UserRound /> <strong>{stats.unassignedTodo}</strong> unassigned</span>
      <span><ShieldAlert /> <strong>{stats.blocked}</strong> blocked</span>
      <span><CheckCircle2 /> <strong>{stats.done}</strong> done</span>
    </Card>
  );
}

function Onboarding({ onCreateProject }) {
  return (
    <section className="setup-card">
      <div>
        <h2>Create a project</h2>
        <p>Tickets are project-scoped. Workspaces can be attached later when an agent starts work.</p>
      </div>
      <ProjectForm onSubmit={onCreateProject} />
    </section>
  );
}

function ProjectForm({ onSubmit }) {
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    setBusy(true);
    try {
      const result = await chooseProjectFolder();
      setRepoPath(result.repoPath || "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="entry-form" onSubmit={onSubmit}>
      <label className="entry-row">
        <span><strong>Project name</strong><small>The repository or product area tickets belong to.</small></span>
        <input name="name" placeholder="jupiter-mobile" required />
      </label>
      <label className="entry-row">
        <span><strong>Ticket key</strong><small>Short uppercase prefix used for issue IDs.</small></span>
        <input name="prefix" placeholder="JMOBILE" />
      </label>
      <label className="entry-row entry-row-wide">
        <span><strong>Repository folder</strong><small>Local folder agents should use for this project.</small></span>
        <div className="path-picker">
          <input name="repoPath" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/Users/you/code/project" />
          <button type="button" className="quiet-button" onClick={browse} disabled={busy}><FolderOpen /> {busy ? "Browsing" : "Browse"}</button>
        </div>
      </label>
      <label className="entry-row entry-row-wide">
        <span><strong>Setup script</strong><small>Runs in each new ticket worktree before the agent starts.</small></span>
        <textarea name="setupScript" placeholder="pnpm install&#10;cp .env.example .env" />
      </label>
      <div className="entry-actions">
        <span className="subtle-copy">Projects define ticket IDs and the workspace root.</span>
        <button><Plus /> Create project</button>
      </div>
    </form>
  );
}

function CreateTicket({ state, onSubmit, compact = false, defaults = {} }) {
  if (compact) {
    return (
      <form className="ticket-compose" onSubmit={onSubmit}>
        <div className="compose-body">
          <input className="compose-title" id="quickCreateTitle" name="title" placeholder="Issue title" required />
          <textarea className="compose-description" name="description" placeholder="Describe the work, acceptance criteria, links, or context for the agent." />
        </div>
        <div className="compose-meta">
          <label>
            Project
            <select name="projectId" required defaultValue={defaults.projectId || ""}>
              <option value="" disabled>Select project</option>
              {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>
            Assignee
            <select name="assigneeAgentId" defaultValue={defaults.assigneeAgentId || ""}>
              <option value="">No assignee</option>
              {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label>
            Parent
            <select name="parentTicketId" defaultValue={defaults.parentTicketId || ""}>
              <option value="">No parent</option>
              {state.tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.id} · {ticket.title}</option>)}
            </select>
          </label>
        </div>
        <div className="compose-footer">
          <span className="subtle-copy">Unassigned to-do tickets stay ready for triage.</span>
          <button><Plus /> Create ticket</button>
        </div>
      </form>
    );
  }
  return (
    <section className="ticket-draft">
      <div className="section-titlebar">
        <div>
          <h2>Quick Create</h2>
          <p>To-do tickets can stay unassigned until someone claims them.</p>
        </div>
      </div>
      <form className="field-grid" onSubmit={onSubmit}>
        <select name="projectId" required defaultValue={defaults.projectId || ""}>
          <option value="" disabled>Select project</option>
          {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <input id="quickCreateTitle" name="title" placeholder="Title" required />
        <select name="assigneeAgentId" defaultValue={defaults.assigneeAgentId || ""}>
          <option value="">No assignee</option>
          {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
        <select name="parentTicketId" defaultValue={defaults.parentTicketId || ""}>
          <option value="">No parent</option>
          {state.tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.id} · {ticket.title}</option>)}
        </select>
        <textarea name="description" placeholder="Description" />
        <button><Plus /> Add ticket</button>
      </form>
    </section>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <Card as="section" className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div className="dialog-crumb">
            <span className="instance-mark">T</span>
            <span>{title}</span>
          </div>
          <Button variant="secondary" className="close-action" onClick={onClose}>Close</Button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function IssueControls({
  state,
  sortBy,
  layout,
  statusFilter,
  projectFilter,
  assigneeFilter,
  presetFilter,
  onSortBy,
  onLayout,
  onStatusFilter,
  onProjectFilter,
  onAssigneeFilter,
  onPresetFilter,
  groupBy,
  onGroupBy,
  resultCount,
}) {
  const [expanded, setExpanded] = useState(false);
  const activeFilterCount = [
    presetFilter !== "all",
    statusFilter !== "all",
    projectFilter !== "all",
    assigneeFilter !== "all",
  ].filter(Boolean).length;
  const clearFilters = () => {
    onPresetFilter("all");
    onStatusFilter("all");
    onProjectFilter("all");
    onAssigneeFilter("all");
  };
  return (
    <section className="filter-bar">
      <div className="filter-summary">
        <span><SlidersHorizontal /> {resultCount} ticket{resultCount === 1 ? "" : "s"}</span>
        <span className={activeFilterCount ? "filter-count active" : "filter-count"}>{activeFilterCount} filters</span>
        {presetFilter !== "all" ? <span className="filter-count active">{TICKET_PRESET_LABELS[presetFilter] || "Dashboard"}</span> : null}
      </div>
      <div className="quick-filters">
        <div className="layout-toggle" aria-label="Ticket layout">
          <button className={layout === "board" ? "active" : ""} onClick={() => onLayout("board")} title="Board layout"><Columns3 /></button>
          <button className={layout === "list" ? "active" : ""} onClick={() => onLayout("list")} title="List layout"><List /></button>
        </div>
        <button className={statusFilter === "all" && assigneeFilter === "all" ? "active" : ""} onClick={clearFilters}>All</button>
        <button className={statusFilter === "human_review" ? "active" : ""} onClick={() => onStatusFilter("human_review")}>Human review</button>
        <button className={statusFilter === "pr_review" ? "active" : ""} onClick={() => onStatusFilter("pr_review")}>PR review</button>
        <button className={assigneeFilter === "unassigned" ? "active" : ""} onClick={() => onAssigneeFilter("unassigned")}>Unassigned</button>
        {activeFilterCount ? <button onClick={clearFilters}>Clear</button> : null}
        <button className={expanded ? "active" : ""} onClick={() => setExpanded((value) => !value)}><SlidersHorizontal /> Filters</button>
      </div>
      {(expanded || activeFilterCount > 0) && <div className="filter-selects">
        <label>
          Status
          <select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            {state.statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </label>
        <label>
          Project
          <select value={projectFilter} onChange={(event) => onProjectFilter(event.target.value)}>
            <option value="all">All projects</option>
            {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>
          Assignee
          <select value={assigneeFilter} onChange={(event) => onAssigneeFilter(event.target.value)}>
            <option value="all">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <label>
          Group
          <select value={groupBy} onChange={(event) => onGroupBy(event.target.value)}>
            <option value="status">Status</option>
            <option value="assignee">Assignee</option>
            <option value="project">Project</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          Sort
          <select value={sortBy} onChange={(event) => onSortBy(event.target.value)}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="status">Status</option>
            <option value="id">Ticket ID</option>
            <option value="title">Title</option>
          </select>
        </label>
      </div>}
    </section>
  );
}

function ProjectsView({ state, selectedProjectId, onSelectProject, onBack, onCreateProject, onUpdateProject, onOpenTicket, onNewTicket }) {
  const selectedProject = findProjectByIdentifier(state.projects, selectedProjectId);
  if (selectedProjectId) {
    return (
      <ProjectDetail
        state={state}
        project={selectedProject}
        onBack={onBack}
        onOpenTicket={onOpenTicket}
        onNewTicket={onNewTicket}
        onUpdateProject={onUpdateProject}
      />
    );
  }
  return (
    <section className="projects-layout">
      <div className="data-panel">
        <div className="section-titlebar">
          <div>
            <h2>Projects</h2>
            <p>Registered repositories that can own tickets.</p>
          </div>
        </div>
        <div className="record-list">
          {state.projects.length ? state.projects.map((project) => (
            <button className="record-row" key={project.id} onClick={() => onSelectProject(project.id)}>
              <div>
                <strong>{project.name}</strong>
                <span>{project.prefix} · next ticket {project.nextTicketNumber}</span>
              </div>
              <code>{project.repoPath || "No repository path"}</code>
            </button>
          )) : <EmptyPanel message="No projects yet." />}
        </div>
      </div>
      <div className="data-panel project-create-panel">
        <div className="section-titlebar">
          <div>
            <h2>Add Project</h2>
            <p>Create a project and attach its local repository folder.</p>
          </div>
        </div>
        <div className="data-panel-content">
          <ProjectForm onSubmit={onCreateProject} />
        </div>
      </div>
    </section>
  );
}

function ProjectDetail({ state, project, onBack, onOpenTicket, onNewTicket, onUpdateProject }) {
  const [setupScript, setSetupScript] = useState(project?.setupScript || "");
  const [setupScriptEditorOpen, setSetupScriptEditorOpen] = useState(false);
  const [setupScriptSaving, setSetupScriptSaving] = useState(false);
  useEffect(() => {
    setSetupScript(project?.setupScript || "");
  }, [project?.id, project?.setupScript]);

  if (!project) {
    return (
      <section className="project-detail-layout">
        <button className="close-action" onClick={onBack}>Back to projects</button>
        <EmptyPanel message="Project not found." />
      </section>
    );
  }
  const tickets = state.tickets.filter((ticket) => ticket.projectId === project.id);
  const open = tickets.filter((ticket) => !["done", "cancelled"].includes(ticket.status));
  const unassigned = open.filter((ticket) => !ticket.assigneeAgentId);
  const blocked = tickets.filter((ticket) => ticket.status === "blocked");
  const done = tickets.filter((ticket) => ticket.status === "done");
  const projectTickets = [...tickets].sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt));
  const defaultAssigneeAgentId = preferredProjectAssigneeId(state, open);
  const statusRows = BOARD_STATUSES.map((status) => ({
    status,
    label: state.statuses.find((item) => item.value === status)?.label || titleCase(status),
    count: tickets.filter((ticket) => ticket.status === status).length,
  })).filter((row) => row.count > 0);
  const agents = state.agents.map((agent) => ({
    agent,
    count: open.filter((ticket) => ticket.assigneeAgentId === agent.id).length,
  })).filter((row) => row.count > 0);
  const setupScriptConfigured = String(project.setupScript || "").trim().length > 0;
  const setupScriptPreview = String(project.setupScript || "").split(/\r?\n/).find((line) => line.trim()) || "No setup script";
  const saveSetupScript = async (event) => {
    event.preventDefault();
    setSetupScriptSaving(true);
    try {
      await onUpdateProject(project.id, { setupScript });
      setSetupScriptEditorOpen(false);
    } finally {
      setSetupScriptSaving(false);
    }
  };

  return (
    <section className="project-detail-layout">
      <button className="close-action" onClick={onBack}>Back to projects</button>
      <div className="project-summary-strip">
        <span><strong>{open.length}</strong> open</span>
        <span><strong>{unassigned.length}</strong> unassigned</span>
        <span><strong>{blocked.length}</strong> blocked</span>
        <span><strong>{done.length}</strong> done</span>
      </div>
      <div className="data-panel project-setup-action">
        <div>
          <strong>{setupScriptConfigured ? "Setup script configured" : "No setup script"}</strong>
          <code>{setupScriptPreview}</code>
        </div>
        <button type="button" className="quiet-button" onClick={() => setSetupScriptEditorOpen(true)}>
          <SquarePen /> Edit setup script
        </button>
      </div>
      <div className="project-detail-grid">
        <div className="data-panel">
          <div className="section-titlebar">
            <div>
              <h2>Tickets</h2>
              <p>{project.prefix} · {project.repoPath || "No repository path"}</p>
            </div>
            <div className="section-actions">
              <span className="panel-count">{tickets.length}</span>
              <button
                type="button"
                className="quiet-button icon-action"
                onClick={() => onNewTicket({ projectId: project.id, assigneeAgentId: defaultAssigneeAgentId })}
                title="New ticket"
                aria-label="New ticket"
              >
                <Plus />
              </button>
            </div>
          </div>
          <div className="row-stack">
            {projectTickets.length ? projectTickets.map((ticket) => (
              <DashboardTicketRow key={ticket.id} ticket={ticket} run={runningRunForTicket(state.runs || [], ticket.id)} onOpenTicket={onOpenTicket} />
            )) : <EmptyPanel message="No tickets for this project." />}
          </div>
        </div>
        <aside className="project-rail">
          <div className="data-panel">
            <div className="section-titlebar"><h2>Status</h2></div>
            <div className="status-list">
              {statusRows.length ? statusRows.map((row) => (
                <div className="status-row" key={row.status}>
                  <span><StatusIcon status={row.status} /> {row.label}</span>
                  <strong>{row.count}</strong>
                </div>
              )) : <EmptyPanel message="No status data." />}
            </div>
          </div>
          <div className="data-panel">
            <div className="section-titlebar"><h2>Agents</h2></div>
            <div className="status-list">
              {agents.length ? agents.map((row) => (
                <div className="status-row" key={row.agent.id}>
                  <span><span className={`presence-dot agent-${row.agent.status}`} /> {row.agent.name}</span>
                  <strong>{row.count}</strong>
                </div>
              )) : <EmptyPanel message="No assigned open work." />}
            </div>
          </div>
        </aside>
      </div>
      {setupScriptEditorOpen && (
        <Modal title="Setup Script" onClose={() => setSetupScriptEditorOpen(false)}>
          <form className="setup-script-form" onSubmit={saveSetupScript}>
            <textarea
              className="setup-script-textarea"
              value={setupScript}
              onChange={(event) => setSetupScript(event.target.value)}
              placeholder="pnpm install&#10;cp .env.example .env"
              autoFocus
            />
            <div className="compose-footer">
              <span className="subtle-copy">Runs after Thomas creates a fresh ticket worktree.</span>
              <button type="submit" disabled={setupScriptSaving}>
                <CheckCircle2 /> {setupScriptSaving ? "Saving" : "Save setup script"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function usageLinkForAgent(agent) {
  const text = `${agent.type || ""} ${agent.command || ""} ${agent.name || ""}`.toLowerCase();
  if (text.includes("codex") || text.includes("openai")) {
    return {
      provider: "Codex",
      href: "https://chatgpt.com/codex/settings/usage",
      description: "Open the ChatGPT Codex usage dashboard.",
    };
  }
  if (text.includes("claude") || text.includes("anthropic")) {
    return {
      provider: "Claude",
      href: "https://claude.ai/settings/usage",
      description: "Open the Claude usage dashboard.",
    };
  }
  return null;
}

function AgentsView({ state, selectedAgentId, onSelectAgent, onBack, onCreateAgent, onOpenTicket }) {
  const selectedAgent = state.agents.find((agent) => agent.id === selectedAgentId) || null;
  const usageLink = selectedAgent ? usageLinkForAgent(selectedAgent) : null;
  const assignedTickets = selectedAgent
    ? state.tickets.filter((ticket) => ticket.assigneeAgentId === selectedAgent.id)
    : [];
  const openTickets = assignedTickets.filter((ticket) => !["done", "cancelled"].includes(ticket.status));
  const reviewTickets = assignedTickets.filter((ticket) => ["human_review", "pr_review"].includes(ticket.status));
  const blockedTickets = assignedTickets.filter((ticket) => ticket.status === "blocked");
  const completedTickets = assignedTickets.filter((ticket) => ticket.status === "done");
  const recentTickets = [...assignedTickets].sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt)).slice(0, 8);
  const solvedTickets = [...completedTickets].sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt)).slice(0, 6);

  if (selectedAgentId) {
    return (
      <section className="agent-profile-layout">
        <button className="close-action" onClick={onBack}>Back to agents</button>
        {selectedAgent ? (
          <div className="agent-profile-grid">
            <div className="data-panel agent-profile-main">
              <div className="section-titlebar">
                <div>
                  <h2>{selectedAgent.name}</h2>
                  <p>{selectedAgent.type} · {selectedAgent.status}</p>
                </div>
                <span className={`presence-dot agent-${selectedAgent.status}`} />
              </div>
              <div className="agent-metrics">
                <span><strong>{openTickets.length}</strong> open</span>
                <span><strong>{reviewTickets.length}</strong> review</span>
                <span><strong>{blockedTickets.length}</strong> blocked</span>
                <span><strong>{completedTickets.length}</strong> done</span>
              </div>
              <div className="usage-card">
                <div>
                  <h3>Usage</h3>
                  <span>{usageLink ? usageLink.provider : "custom"}</span>
                </div>
                <p>{usageLink ? usageLink.description : "No provider usage page is configured for this custom agent."}</p>
                {usageLink ? (
                  <a className="usage-link" href={usageLink.href} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open usage
                  </a>
                ) : null}
              </div>
              <div className="fact-list compact-facts">
                <div><span>Command</span><code>{selectedAgent.command || "No command configured"}</code></div>
                <div><span>Type</span><strong>{selectedAgent.type}</strong></div>
                <div><span>Status</span><strong>{selectedAgent.status}</strong></div>
              </div>
            </div>
            <div className="data-panel">
              <div className="section-titlebar"><h2>Recently Solved</h2></div>
              <div className="row-stack">
                {solvedTickets.length ? solvedTickets.map((ticket) => (
                  <DashboardTicketRow key={ticket.id} ticket={ticket} run={runningRunForTicket(state.runs || [], ticket.id)} onOpenTicket={onOpenTicket} />
                )) : <EmptyPanel message="No solved tickets yet." />}
              </div>
            </div>
            <div className="data-panel">
              <div className="section-titlebar"><h2>Recent Work</h2></div>
              <div className="row-stack">
                {recentTickets.length ? recentTickets.map((ticket) => (
                  <DashboardTicketRow key={ticket.id} ticket={ticket} run={runningRunForTicket(state.runs || [], ticket.id)} onOpenTicket={onOpenTicket} />
                )) : <EmptyPanel message="No assigned tickets yet." />}
              </div>
            </div>
          </div>
        ) : <EmptyPanel message="Agent not found." />}
      </section>
    );
  }

  return (
    <section className="settings-layout">
      <div className="data-panel">
        <div className="section-titlebar">
          <div>
            <h2>Agents</h2>
            <p>Agent profiles available for assignment.</p>
          </div>
        </div>
        <div className="record-list">
          {state.agents.map((agent) => (
            <button className="record-row agent-record" key={agent.id} onClick={() => onSelectAgent(agent.id)}>
              <div>
                <strong><span className={`presence-dot agent-${agent.status}`} /> {agent.name}</strong>
                <span>{agent.type} · {agent.status}</span>
              </div>
              <code>{state.tickets.filter((ticket) => ticket.assigneeAgentId === agent.id && !["done", "cancelled"].includes(ticket.status)).length} open · {agent.command || "No command configured"}</code>
            </button>
          ))}
        </div>
      </div>
      <div className="data-panel add-agent-panel">
        <div className="section-titlebar">
          <div>
            <h2>Add Agent</h2>
            <p>Register a local agent command that tickets can be assigned to.</p>
          </div>
        </div>
        <div className="data-panel-content">
          <form className="entry-form agent-entry-form" onSubmit={onCreateAgent}>
            <label className="entry-row">
              <span><strong>Name</strong><small>Display name used in tickets and workload.</small></span>
              <input name="name" placeholder="Codex" required />
            </label>
            <label className="entry-row">
              <span><strong>Type</strong><small>Provider profile for account and usage lookup.</small></span>
              <select name="type" defaultValue="codex">
                <option value="codex">codex</option>
                <option value="claude">claude</option>
                <option value="custom">custom</option>
              </select>
            </label>
            <label className="entry-row">
              <span><strong>Command</strong><small>Executable agents can run locally.</small></span>
              <input name="command" placeholder="codex" />
            </label>
            <label className="entry-row">
              <span><strong>Status</strong><small>Paused agents remain visible but are not active.</small></span>
              <select name="status" defaultValue="available">
                <option value="available">available</option>
                <option value="paused">paused</option>
              </select>
            </label>
            <div className="entry-actions">
              <span className="subtle-copy">Usage details come from known local provider state when available.</span>
              <button><Plus /> Add agent</button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

function SettingsView({ state, onUpdateSettings }) {
  const serverSettings = state.settings || {};
  const cacheBytes = state.cache?.bytes || 0;
  const [pendingPatch, setPendingPatch] = useState({});
  const settings = { ...serverSettings, ...pendingPatch };
  const [branchPrefixDraft, setBranchPrefixDraft] = useState(serverSettings.branchPrefix || "thomas");
  const [notificationStatus, setNotificationStatus] = useState(() => notificationSupportStatus().message);
  const [savedKey, setSavedKey] = useState("");
  const savedTimeoutRef = useRef(null);
  useEffect(() => {
    setBranchPrefixDraft(serverSettings.branchPrefix || "thomas");
  }, [serverSettings.branchPrefix]);
  useEffect(() => () => clearTimeout(savedTimeoutRef.current), []);
  const handlePatch = async (key, patch) => {
    setPendingPatch((prev) => ({ ...prev, ...patch }));
    setSavedKey(key);
    clearTimeout(savedTimeoutRef.current);
    savedTimeoutRef.current = setTimeout(() => setSavedKey(""), 1600);
    try {
      await onUpdateSettings(patch);
    } finally {
      setPendingPatch((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
    }
  };
  const commitBranchPrefix = () => {
    const next = branchPrefixDraft.trim() || "thomas";
    if (next === (serverSettings.branchPrefix || "thomas")) return;
    handlePatch("branchPrefix", { branchPrefix: next });
  };
  const testNotification = async () => {
    const support = notificationSupportStatus();
    if (!support.supported) {
      setNotificationStatus(support.message);
      return;
    }
    let permission = Notification.permission;
    try {
      if (permission === "default") permission = await Notification.requestPermission();
    } catch (err) {
      setNotificationStatus(`Notification permission could not be requested: ${err.message}`);
      return;
    }
    if (permission === "granted") {
      setNotificationStatus(await showThomasNotification("Thomas", {
        body: "Test notification: Human Review alerts are available.",
        tag: "thomas-test-notification",
      }));
      return;
    }
    setNotificationStatus(permission === "denied" ? "Notifications are blocked for this browser. Allow them in site settings, then test again." : "Notification permission was not granted.");
  };
  return (
    <section className="grid w-full max-w-[760px] gap-4">
      <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-card/95 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-border/70 bg-card/70 px-3.5 py-2.5">
          <span className="inline-flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-[10px] uppercase tracking-wide">Version</span>
            <code className="font-mono text-xs font-medium text-foreground">{state.appVersion || "unknown"}</code>
          </span>
          <span className="inline-flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-[10px] uppercase tracking-wide">Cache</span>
            <code className="font-mono text-xs font-medium text-foreground">{formatBytes(cacheBytes)}</code>
          </span>
        </div>

        <SettingsSection title="Appearance">
          <SettingsRow as="label" title="Theme" description="Applies to this local UI.">
            <SettingsControl>
              <SavedIndicator visible={savedKey === "theme"} />
              <SettingsSelect
                value={settings.theme || "system"}
                onChange={(event) => handlePatch("theme", { theme: event.target.value })}
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </SettingsSelect>
            </SettingsControl>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Workflow">
          <SettingsRow as="label" title="Default terminal" description="Used by the ticket resume button.">
            <SettingsControl>
              <SavedIndicator visible={savedKey === "preferredTerminal"} />
              <SettingsSelect
                value={settings.preferredTerminal || "warp"}
                onChange={(event) => handlePatch("preferredTerminal", { preferredTerminal: event.target.value })}
              >
                {TERMINAL_OPTIONS.map((terminal) => <option key={terminal.value} value={terminal.value}>{terminal.label}</option>)}
              </SettingsSelect>
            </SettingsControl>
          </SettingsRow>
          <SettingsRow
            as="form"
            title="Branch prefix"
            description="New worktree branches use this prefix."
            onSubmit={(event) => {
              event.preventDefault();
              commitBranchPrefix();
              event.currentTarget.querySelector("input")?.blur();
            }}
          >
            <SettingsControl>
              <SavedIndicator visible={savedKey === "branchPrefix"} />
              <Input
                className="h-8 w-[180px] text-sm"
                value={branchPrefixDraft}
                onChange={(event) => setBranchPrefixDraft(event.target.value)}
                onBlur={commitBranchPrefix}
                placeholder="thomas"
              />
            </SettingsControl>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Agents">
          <SettingsRow title="Use Claude agents tab" description="Dispatches Claude with --bg so runs appear in Claude Code's agents tab and can be stopped from there.">
            <SettingsControl>
              <SavedIndicator visible={savedKey === "useClaudeAgents"} />
              <Switch
                aria-label="Use Claude agents tab"
                checked={settings.useClaudeAgents !== false}
                onCheckedChange={(next) => handlePatch("useClaudeAgents", { useClaudeAgents: next })}
              />
            </SettingsControl>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Notifications">
          <SettingsRow
            title="Notify on Human Review"
            description="Only alert when an agent leaves a ticket ready for review."
            footer={<small className="notification-status">{notificationStatus}</small>}
          >
            <SettingsControl>
              <SavedIndicator visible={savedKey === "notifyHumanReview"} />
              <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground" onClick={testNotification}>Test</Button>
              <Switch
                aria-label="Notify on Human Review"
                checked={settings.notifyHumanReview === true}
                onCheckedChange={(next) => handlePatch("notifyHumanReview", { notifyHumanReview: next })}
              />
            </SettingsControl>
          </SettingsRow>
        </SettingsSection>
      </div>
    </section>
  );
}

function SettingsSection({ title, children }) {
  return (
    <section className="border-t border-border/60 first:border-t-0">
      <div className="px-3.5 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid">{children}</div>
    </section>
  );
}

function SettingsRow({ as: Component = "div", title, description, children, footer, ...props }) {
  return (
    <Component
      className="grid min-h-11 items-center gap-4 px-3.5 py-2 [&+&]:border-t [&+&]:border-border/40"
      style={{ gridTemplateColumns: "minmax(220px, 1fr) auto" }}
      {...props}
    >
      <span className="grid gap-0.5">
        <strong className="text-[13px] font-medium leading-tight">{title}</strong>
        <small className="text-xs leading-snug text-muted-foreground">{description}</small>
      </span>
      {children}
      {footer ? <div className="col-span-2 mt-1">{footer}</div> : null}
    </Component>
  );
}

function SettingsControl({ children }) {
  return <span className="flex min-w-0 items-center justify-end gap-2.5 justify-self-end">{children}</span>;
}

function SettingsSelect({ children, ...props }) {
  return (
    <select
      data-slot="settings-select"
      className="h-8 min-w-[140px] rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[3px]"
      {...props}
    >
      {children}
    </select>
  );
}

function SavedIndicator({ visible }) {
  return (
    <span
      data-visible={visible ? "true" : "false"}
      aria-hidden={!visible}
      className="pointer-events-none inline-flex items-center gap-1 text-[11px] text-[var(--green)] opacity-0 transition-opacity duration-150 data-[visible=true]:opacity-100"
    >
      <CheckCircle2 className="size-3" /> Saved
    </span>
  );
}

function notificationSupportStatus() {
  if (typeof window === "undefined") {
    return { supported: false, message: "Browser notifications are checked when the UI loads." };
  }
  if (window.isSecureContext === false) {
    return {
      supported: false,
      message: "Browser notifications require HTTPS or localhost. Open Thomas from the Tailscale HTTPS URL, not the 100.x HTTP URL.",
    };
  }
  if (!("Notification" in window)) {
    if (isLikelyIos()) {
      return { supported: false, message: "On iPhone/iPad, open the Tailscale HTTPS URL in Safari, choose Share → Add to Home Screen, then launch Thomas from the Home Screen before enabling notifications." };
    }
    return { supported: false, message: "Browser notifications are not available in this browser." };
  }
  if (Notification.permission === "denied") {
    return { supported: true, message: "Notifications are blocked for this browser. Allow them in site settings, then test again." };
  }
  if (Notification.permission === "granted") {
    return { supported: true, message: "Notifications are enabled for this browser." };
  }
  if (isLikelyIos() && !isStandaloneWebApp()) {
    return { supported: true, message: "For reliable iPhone/iPad alerts, Add Thomas to your Home Screen from the Tailscale HTTPS URL and launch it from there before testing." };
  }
  return { supported: true, message: "Use Test to request browser permission and send a notification." };
}

function isLikelyIos() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneWebApp() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone === true;
}

function registerThomasServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || typeof window === "undefined" || window.isSecureContext === false) return;
  navigator.serviceWorker.register("/thomas-sw.js").catch(() => {});
}

async function showThomasNotification(title, options = {}) {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration?.showNotification) {
        await registration.showNotification(title, options);
        return "Test notification sent by the Thomas web app.";
      }
    }
    new Notification(title, options);
    return "Test notification sent by this browser.";
  } catch (err) {
    return `Notification could not be shown: ${err.message}`;
  }
}

function notifyHumanReviewTickets(state, notifiedIds, baselineReadyRef) {
  const humanReviewTickets = (state.tickets || []).filter((ticket) => ticket.status === "human_review");
  if (!baselineReadyRef.current) {
    for (const ticket of humanReviewTickets) notifiedIds.add(ticket.id);
    baselineReadyRef.current = true;
    return;
  }
  if (state.settings?.notifyHumanReview !== true || typeof Notification === "undefined" || Notification.permission !== "granted") {
    for (const ticket of humanReviewTickets) notifiedIds.add(ticket.id);
    return;
  }
  for (const ticket of humanReviewTickets) {
    if (notifiedIds.has(ticket.id)) continue;
    notifiedIds.add(ticket.id);
    showThomasNotification(`Thomas: ${ticket.id} needs review`, {
      body: ticket.title || "A ticket is ready for human review.",
      tag: `thomas-human-review-${ticket.id}`,
    });
  }
}

function ActivityView({ state }) {
  return (
    <section className="data-panel">
      <div className="section-titlebar">
        <div>
          <h2>Activity</h2>
          <p>Recent local API, ticket, project, and agent events.</p>
        </div>
      </div>
      <div className="activity-table">
        <div className="activity-table-head"><span>Event</span><span>Actor</span><span>Subject</span><span>When</span></div>
        {state.activity.length ? state.activity.map((event) => (
          <div className="activity-row" key={event.id}>
            <div>
              <strong>{event.type}</strong>
              <code>{event.id}</code>
            </div>
            <span>{event.actor || "api"}</span>
            <span>{event.subject || event.details?.ticketId || event.details?.projectId || event.details?.agentId || "system"}</span>
            <time>{timeAgo(event.createdAt)}</time>
          </div>
        )) : <EmptyPanel message="No activity yet." />}
      </div>
    </section>
  );
}

function Dashboard({ state, onOpenTicket, onOpenTicketsPreset, onOpenTicketsStatus, onOpenAgent, onOpenProject }) {
  const runs = state.runs || [];
  const openTickets = state.tickets.filter((ticket) => !["done", "cancelled"].includes(ticket.status));
  const reviewTickets = openTickets.filter((ticket) => ["human_review", "pr_review"].includes(ticket.status));
  const runningTicketIds = new Set(runs.filter((run) => run.status === "running").map((run) => run.ticketId));
  const inFlightCount = openTickets.filter((ticket) => ticket.status === "in_progress" || runningTicketIds.has(ticket.id)).length;
  const agentWorkload = state.agents.map((agent) => {
    const assigned = openTickets.filter((ticket) => ticket.assigneeAgentId === agent.id);
    return {
      agent,
      assigned,
      review: assigned.filter((ticket) => ["human_review", "pr_review"].includes(ticket.status)).length,
      blocked: assigned.filter((ticket) => ticket.status === "blocked").length,
    };
  });
  const unassigned = openTickets.filter((ticket) => !ticket.assigneeAgentId);
  const maxAgentLoad = Math.max(1, ...agentWorkload.map((row) => row.assigned.length), unassigned.length);
  const statusRows = BOARD_STATUSES.map((status) => ({
    status,
    label: state.statuses.find((item) => item.value === status)?.label || titleCase(status),
    count: openTickets.filter((ticket) => ticket.status === status).length,
    share: openTickets.length ? Math.round((openTickets.filter((ticket) => ticket.status === status).length / openTickets.length) * 100) : 0,
  })).filter((row) => row.count > 0);
  const projectRows = state.projects.map((project) => ({
    project,
    open: openTickets.filter((ticket) => ticket.projectId === project.id).length,
    review: openTickets.filter((ticket) => ticket.projectId === project.id && ["human_review", "pr_review"].includes(ticket.status)).length,
    blocked: openTickets.filter((ticket) => ticket.projectId === project.id && ticket.status === "blocked").length,
  })).filter((row) => row.open > 0 || row.review > 0);
  return (
    <section className="operations-dashboard">
      <div className="ops-main">
        <div className="dashboard-signal-grid">
          <DashboardMetricCard icon={CircleDot} label="In Flight" value={inFlightCount} detail={`${runningTicketIds.size} running`} tone="blue" onClick={() => onOpenTicketsPreset("in_flight")} />
          <DashboardMetricCard icon={ShieldAlert} label="Needs Review" value={reviewTickets.length} detail={`${state.stats.blocked} blocked`} tone="yellow" onClick={() => onOpenTicketsPreset("needs_review")} />
          <DashboardMetricCard icon={UserRound} label="Unassigned" value={state.stats.unassignedTodo} detail="ready to triage" tone="violet" onClick={() => onOpenTicketsPreset("unassigned")} />
          <DashboardMetricCard icon={CheckCircle2} label="Completed" value={state.stats.done} detail="archived locally" tone="green" onClick={() => onOpenTicketsPreset("done")} />
        </div>
      </div>
      <aside className="ops-rail">
        <div className="data-panel ops-panel">
          <div className="section-titlebar"><h2>Agent Workload</h2></div>
          <div className="workload-list">
            {agentWorkload.map((row) => (
              <button type="button" className="workload-row row-link" key={row.agent.id} onClick={() => onOpenAgent(row.agent.id)}>
                <div className="workload-identity">
                  <span className={`presence-dot agent-${row.agent.status}`} />
                  <span>
                    <strong>{row.agent.name}</strong>
                    <small>{row.review} review · {row.blocked} blocked</small>
                  </span>
                </div>
                <div className="workload-meter" aria-label={`${row.agent.name} has ${row.assigned.length} open tickets`}>
                  <span style={{ width: `${Math.max(6, (row.assigned.length / maxAgentLoad) * 100)}%` }} />
                </div>
                <strong className="rail-count">{row.assigned.length}</strong>
              </button>
            ))}
            <button type="button" className="workload-row workload-unassigned row-link" onClick={() => onOpenTicketsPreset("unassigned")}>
              <div className="workload-identity">
                <span className="presence-dot presence-muted" />
                <span>
                  <strong>Unassigned</strong>
                  <small>triage queue</small>
                </span>
              </div>
              <div className="workload-meter" aria-label={`${unassigned.length} unassigned open tickets`}>
                <span style={{ width: `${Math.max(6, (unassigned.length / maxAgentLoad) * 100)}%` }} />
              </div>
              <strong className="rail-count">{unassigned.length}</strong>
            </button>
          </div>
        </div>

        <div className="data-panel ops-panel">
          <div className="section-titlebar"><h2>Status Mix</h2></div>
          <div className="status-list">
            {statusRows.map((row) => (
              <button type="button" className="status-row status-mix-row row-link" key={row.status} onClick={() => onOpenTicketsStatus(row.status)}>
                <span><StatusIcon status={row.status} /> {row.label}</span>
                <div className="status-meter"><span style={{ width: `${Math.max(4, row.share)}%` }} /></div>
                <strong>{row.count}</strong>
              </button>
            ))}
          </div>
        </div>

        <div className="data-panel ops-panel">
          <div className="section-titlebar"><h2>Project Queues</h2></div>
          <div className="status-list">
            {projectRows.length ? projectRows.map((row) => (
              <button type="button" className="status-row project-queue-row row-link" key={row.project.id} onClick={() => onOpenProject(row.project.id)}>
                <span>{row.project.name}</span>
                <div>
                  {row.review ? <em>{row.review} review</em> : null}
                  {row.blocked ? <em>{row.blocked} blocked</em> : null}
                </div>
                <strong>{row.open}</strong>
              </button>
            )) : <EmptyPanel message="No open project work." />}
          </div>
        </div>

      </aside>
    </section>
  );
}

function DashboardMetricCard({ icon: Icon, label, value, detail, tone, onClick }) {
  return (
    <button type="button" className="dashboard-metric-card" data-tone={tone} onClick={onClick}>
      <span><Icon /></span>
      <div>
        <strong>{value}</strong>
        <p>{label}</p>
      </div>
      <small>{detail}</small>
    </button>
  );
}

function EmptyPanel({ message }) {
  return <div className="blank-row ui-empty">{message}</div>;
}

function InboxView({ state, onOpenTicket }) {
  const runs = state.runs || [];
  const blocked = state.tickets
    .filter((ticket) => ticket.status === "blocked")
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
  const unassigned = state.tickets
    .filter((ticket) => ticket.status === "todo" && !ticket.assigneeAgentId)
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
  const review = state.tickets
    .filter((ticket) => ticket.status === "human_review")
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));
  const prReview = state.tickets
    .filter((ticket) => ticket.status === "pr_review")
    .sort((a, b) => dateValue(b.updatedAt) - dateValue(a.updatedAt));

  return (
    <section className="inbox-workspace">
      <div className="inbox-triage-list">
        <InboxQueuePanel title="Human Review" description="Agent handoffs waiting for your decision." count={review.length} tone="review" tickets={review} runs={runs} empty="No human review tickets." onOpenTicket={onOpenTicket} />
        <InboxQueuePanel title="PR Review" description="Pull requests waiting for review or merge." count={prReview.length} tone="pr" tickets={prReview} runs={runs} empty="No PR review tickets." onOpenTicket={onOpenTicket} />
        <InboxQueuePanel title="Blocked" description="Tickets that need an unblock decision." count={blocked.length} tone="blocked" tickets={blocked} runs={runs} empty="No blocked tickets." onOpenTicket={onOpenTicket} />
        <InboxQueuePanel title="Unassigned" description="To-do tickets ready for triage." count={unassigned.length} tone="unassigned" tickets={unassigned} runs={runs} empty="No unassigned to-do tickets." onOpenTicket={onOpenTicket} />
      </div>
    </section>
  );
}

function InboxQueuePanel({ title, description, count, tone, tickets, runs = [], empty, onOpenTicket }) {
  return (
    <div className="data-panel inbox-panel inbox-queue-panel" data-tone={tone}>
      <div className="section-titlebar">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="panel-count">{count}</span>
      </div>
      <div className="row-stack">
        {tickets.length ? tickets.map((ticket) => (
          <DashboardTicketRow key={ticket.id} ticket={ticket} run={runningRunForTicket(runs, ticket.id)} onOpenTicket={onOpenTicket} />
        )) : <EmptyPanel message={empty} />}
      </div>
    </div>
  );
}

function Board({ state, tickets, onOpenTicket }) {
  const labelFor = (status) => state.statuses.find((item) => item.value === status)?.label || status;
  return (
    <KanbanBoard
      statuses={BOARD_STATUSES}
      tickets={tickets}
      runs={state.runs || []}
      statusLabel={labelFor}
      onOpenTicket={onOpenTicket}
    />
  );
}

function TicketList({ tickets, runs = [], groupBy, onOpenTicket }) {
  const groups = groupTickets(tickets, groupBy);
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const toggleGroup = (groupKey) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };
  return (
    <section className="data-panel">
      <div className="issue-table">
        <div className="issue-table-head"><span>Ticket</span><span>Assignee</span><span>Project</span><span>Updated</span></div>
        {groups.map((group) => (
          <div className="issue-group" key={group.key}>
            {groupBy !== "none" ? (
              <button
                className={`issue-group-header${collapsedGroups.has(group.key) ? " collapsed" : ""}`}
                onClick={() => toggleGroup(group.key)}
              >
                <span><ChevronDown className="group-caret" /> {group.label}</span>
                <small>{group.tickets.length} ticket{group.tickets.length === 1 ? "" : "s"} <Plus /></small>
              </button>
            ) : null}
            {!collapsedGroups.has(group.key) && group.tickets.map((ticket) => (
                <IssueRow key={ticket.id} ticket={ticket} run={runningRunForTicket(runs, ticket.id)} onOpenTicket={onOpenTicket} />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function groupTickets(tickets, groupBy) {
  if (groupBy === "none") return [{ key: "all", label: "All", tickets }];
  const groups = new Map();
  for (const ticket of tickets) {
    const key = groupKey(ticket, groupBy);
    if (!groups.has(key)) groups.set(key, { key, label: groupLabel(ticket, groupBy), tickets: [] });
    groups.get(key).tickets.push(ticket);
  }
  return Array.from(groups.values()).sort((a, b) => groupRank(a.key, groupBy) - groupRank(b.key, groupBy) || a.label.localeCompare(b.label));
}

function groupKey(ticket, groupBy) {
  if (groupBy === "assignee") return ticket.assignee?.name || "Unassigned";
  if (groupBy === "project") return ticket.project?.name || "Unknown";
  return ticket.status || "none";
}

function groupLabel(ticket, groupBy) {
  if (groupBy === "assignee") return ticket.assignee?.name || "Unassigned";
  if (groupBy === "project") return ticket.project?.name || "Unknown";
  return ticket.statusLabel || titleCase(ticket.status || "none");
}

function groupRank(key, groupBy) {
  if (groupBy === "status") return statusRank(key);
  return 0;
}

function DashboardTicketRow({ ticket, run = null, onOpenTicket }) {
  return (
    <button className="dashboard-ticket-row" onClick={() => onOpenTicket(ticket.id)}>
      <span className="dashboard-ticket-main">
        <StatusIcon status={ticket.status} />
        <strong>{ticket.id}</strong>
        <span>{ticket.title}</span>
      </span>
      <span className="dashboard-ticket-time">
        <RunningElapsed run={run} compact />
        <time>{timeAgo(ticket.updatedAt)}</time>
      </span>
    </button>
  );
}

function TicketDetail({ state, ticket, onClose, onOpenTicket, onOpenProject, onPatch, onDelete, onStopRun, onRefreshStatus, onRunSetupScript, onOpenWorktree, onResumeTerminal, onStateUpdate, onComment, onCreateSubIssue }) {
  const [detailTab, setDetailTab] = useState("conversation");
  const [comment, setComment] = useState("");
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [statusRefreshBusy, setStatusRefreshBusy] = useState(false);
  const [setupScriptBusy, setSetupScriptBusy] = useState(false);
  const [setupScriptMessage, setSetupScriptMessage] = useState("");
  const [diff, setDiff] = useState(null);
  const [diffError, setDiffError] = useState("");
  const [diffBusy, setDiffBusy] = useState(false);
  const [autoLoadedDiffTicketId, setAutoLoadedDiffTicketId] = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [reviewComment, setReviewComment] = useState("");
  const [blockers, setBlockers] = useState(ticket.blockedByTicketIds.join(", "));
  const [labels, setLabels] = useState(ticket.labels.join(", "));
  const latestComment = ticket.comments.slice().sort((a, b) => dateValue(b.createdAt) - dateValue(a.createdAt))[0];
  const orderedComments = ticket.comments.slice().sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));
  const handoffLines = buildHandoffLines(ticket, latestComment);
  const ticketRuns = (state.runs || [])
    .filter((run) => run.ticketId === ticket.id && ["running", "finished", "failed", "stopped", "interrupted"].includes(run.status))
    .sort((a, b) => dateValue(a.startedAt) - dateValue(b.startedAt));
  const runningTicketRun = state.runs?.find((run) => run.ticketId === ticket.id && run.status === "running") || null;
  const defaultTerminal = state.settings?.preferredTerminal || "warp";

  useEffect(() => {
    setBlockers(ticket.blockedByTicketIds.join(", "));
  }, [ticket.id, ticket.blockedByTicketIds]);

  useEffect(() => {
    setLabels(ticket.labels.join(", "));
  }, [ticket.id, ticket.labels]);

  useEffect(() => {
    setDetailTab("conversation");
    setDiff(null);
    setDiffError("");
    setAutoLoadedDiffTicketId(null);
    setReviewTarget(null);
    setReviewComment("");
    setTerminalMenuOpen(false);
    setStatusRefreshBusy(false);
    setSetupScriptBusy(false);
    setSetupScriptMessage("");
  }, [ticket.id]);

  const refreshStatus = async () => {
    setStatusRefreshBusy(true);
    try {
      await onRefreshStatus(ticket.id);
    } finally {
      setStatusRefreshBusy(false);
    }
  };

  const runSetupScript = async () => {
    setSetupScriptBusy(true);
    setSetupScriptMessage("");
    try {
      const result = await onRunSetupScript(ticket.id);
      const setup = result?.setup;
      setSetupScriptMessage(setup?.skipped ? "No setup script configured." : `Setup script ran in ${setup?.repoPath || "worktree"}.`);
    } catch (err) {
      setSetupScriptMessage(err.message || "Setup script failed.");
    } finally {
      setSetupScriptBusy(false);
    }
  };

  const loadDiff = async () => {
    setDiffBusy(true);
    setDiffError("");
    try {
      setDiff(await fetchTicketDiff(ticket.id));
    } catch (err) {
      setDiffError(err.message);
    } finally {
      setDiffBusy(false);
    }
  };

  useEffect(() => {
    if (detailTab !== "review" || ticket.status !== "human_review" || diff || diffBusy || autoLoadedDiffTicketId === ticket.id) return;
    setAutoLoadedDiffTicketId(ticket.id);
    loadDiff();
  }, [detailTab, ticket.id, ticket.status, diff, diffBusy, autoLoadedDiffTicketId]);

  const submitReviewComment = async (event) => {
    event.preventDefault();
    if (!reviewTarget || !reviewComment.trim()) return;
    await onComment(reviewComment, {
      type: "diff_review",
      filePath: reviewTarget.filePath,
      line: reviewTarget.line,
      side: reviewTarget.side,
    });
    setReviewComment("");
    setReviewTarget(null);
  };

  return (
    <section className="detail-page">
      <div className="detail-shell">
        <div className="detail-heading">
          <div className="detail-topline">
            <button className="close-action" onClick={onClose}>Back</button>
            <button className="quiet-button icon-action" onClick={() => onOpenWorktree(ticket.id)} title="Open worktree in Finder" aria-label="Open worktree in Finder"><FolderOpen /></button>
            <button className="quiet-button icon-action" onClick={runSetupScript} disabled={setupScriptBusy} title="Run setup script in worktree" aria-label="Run setup script in worktree"><RefreshCw /></button>
            <div className="terminal-split-action">
              <button className="quiet-button icon-action terminal-main-action" onClick={() => onResumeTerminal(ticket.id, defaultTerminal)} title={`Open ${terminalLabel(defaultTerminal)} and copy resume command`} aria-label={`Open ${terminalLabel(defaultTerminal)} and copy resume command`}><Terminal /></button>
              <button className="quiet-button icon-action terminal-menu-action" onClick={() => setTerminalMenuOpen((open) => !open)} title="Choose terminal" aria-label="Choose terminal"><ChevronDown /></button>
              {terminalMenuOpen ? (
                <div className="terminal-menu">
                  {TERMINAL_OPTIONS.map((terminal) => (
                    <button
                      key={terminal.value}
                      type="button"
                      className={terminal.value === defaultTerminal ? "active" : ""}
                      onClick={() => {
                        setTerminalMenuOpen(false);
                        onResumeTerminal(ticket.id, terminal.value);
                      }}
                    >
                      {terminal.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {runningTicketRun ? (
              <button className="quiet-button danger-button" onClick={() => onStopRun(ticket.id)}>Stop</button>
            ) : null}
            <button className="quiet-button danger-button icon-action" onClick={() => onDelete(ticket.id)} title="Delete ticket" aria-label="Delete ticket"><Trash2 /></button>
            {ticket.prUrl ? (
              <a className="icon-link" href={ticket.prUrl} title={ticket.prUrl} aria-label="Open pull request">
                <GitPullRequest />
              </a>
            ) : null}
          </div>
          <div className="detail-kicker">
            {setupScriptMessage ? <span className="setup-script-message">{setupScriptMessage}</span> : null}
            <span className="status-refresh-group">
              <span className={`status-chip state-${ticket.status}`}>{ticket.statusLabel}</span>
              <button
                type="button"
                className="quiet-button icon-action status-refresh-button"
                onClick={refreshStatus}
                disabled={statusRefreshBusy}
                title="Refresh ticket status"
                aria-label="Refresh ticket status"
              >
                <RefreshCw />
              </button>
            </span>
            <span className="reference-chip">{ticket.project?.name || "Unknown project"}</span>
            <RunningElapsed run={runningTicketRun} />
          </div>
          <h2>{ticket.title}</h2>
          <p>{ticket.id} · updated {timeAgo(ticket.updatedAt)}</p>
        </div>
        <section className="detail-overview-always">
          <section className="detail-section detail-description">
            <h3>Description</h3>
            <MarkdownText value={ticket.description || "No description yet."} className="detail-copy" />
          </section>

          <section className="handoff-card">
            <div className="section-heading-row">
              <h3><ClipboardList /> Continuation handoff</h3>
              <span>{timeAgo(ticket.updatedAt)}</span>
            </div>
            <div className="handoff-copy">
              {handoffLines.map((line) => <p key={line}>{line}</p>)}
            </div>
          </section>
        </section>
        <div className="detail-tabs" role="tablist" aria-label="Ticket detail sections">
          <button className={detailTab === "conversation" ? "active" : ""} onClick={() => setDetailTab("conversation")}>Conversation</button>
          <button className={detailTab === "plan" ? "active" : ""} onClick={() => setDetailTab("plan")}>Plan</button>
          {ticket.status === "human_review" ? <button className={detailTab === "review" ? "active" : ""} onClick={() => setDetailTab("review")}>Review diff</button> : null}
          <button className={detailTab === "dependencies" ? "active" : ""} onClick={() => setDetailTab("dependencies")}>Dependencies</button>
        </div>
        <div className="detail-layout">
          <div className="detail-primary">
            {detailTab === "conversation" && (
              <section className="detail-tab-panel conversation-tab-panel">
                <ConversationTimeline comments={orderedComments} runs={ticketRuns} />
                <form className="note-form note-form-primary" onSubmit={async (event) => {
                  event.preventDefault();
                  if (!comment.trim()) return;
                  await onComment(comment);
                  setComment("");
                }}>
                  <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment or handoff note" />
                  <button><MessageSquare /> Comment</button>
                </form>
              </section>
            )}

            {detailTab === "plan" && (
              <PlanTab ticket={ticket} onStateUpdate={onStateUpdate} />
            )}

            {detailTab === "review" && (
              <section className="detail-tab-panel diff-review-panel">
                <div className="section-heading-row">
                  <h3><FileDiff /> Review local diff</h3>
                  <button className="quiet-button" onClick={loadDiff} disabled={diffBusy}>{diffBusy ? "Loading" : diff ? "Refresh" : "Load diff"}</button>
                </div>
                {diffError ? <div className="blank-row">{diffError}</div> : null}
                {diff ? (
                  <DiffViewer
                    ticketId={ticket.id}
                    diff={diff}
                    reviewTarget={reviewTarget}
                    reviewComment={reviewComment}
                    onSelectTarget={setReviewTarget}
                    onCommentChange={setReviewComment}
                    onSubmit={submitReviewComment}
                  />
                ) : <EmptyPanel message="Load the current local diff when this ticket is ready for human review." />}
              </section>
            )}

            {detailTab === "dependencies" && (
              <section className="detail-tab-panel dependency-tab">
                <section className="dependency-card">
                  <h3>Blocked by</h3>
                  <div className="dependency-editor">
                    <input value={blockers} onChange={(event) => setBlockers(event.target.value)} placeholder="APP-1, APP-2" />
                    <button onClick={() => onPatch(ticket.id, { blockedByTicketIds: blockers.split(",").map((item) => item.trim()).filter(Boolean) })}>Save</button>
                  </div>
                  {ticket.blockedBy.length ? ticket.blockedBy.map((item) => (
                    <button className="mini-link" key={item.id} onClick={() => onOpenTicket(item.id)}>
                      <StatusIcon status={item.status} />
                      <span className="task-key">{item.id}</span>
                      <span>{item.title}</span>
                    </button>
                  )) : <p className="subtle-copy">No blockers.</p>}
                </section>

                <section className="dependency-card">
                  <h3>Blocking</h3>
                  {ticket.blocks.length ? ticket.blocks.map((item) => (
                    <button className="mini-link" key={item.id} onClick={() => onOpenTicket(item.id)}>
                      <StatusIcon status={item.status} />
                      <span className="task-key">{item.id}</span>
                      <span>{item.title}</span>
                    </button>
                  )) : <p className="subtle-copy">Not blocking other tickets.</p>}
                </section>

                <section className="dependency-card">
                  <h3>Sub-issues</h3>
                  {ticket.children.length ? ticket.children.map((child) => (
                    <button className="mini-link" key={child.id} onClick={() => onOpenTicket(child.id)}>
                      <span className="task-key">{child.id}</span>
                      <span>{child.title}</span>
                    </button>
                  )) : <p className="subtle-copy">No sub-issues.</p>}
                  <button className="quiet-button inline-action" onClick={onCreateSubIssue}><Plus /> Add sub-issue</button>
                </section>
              </section>
            )}
          </div>

          <aside className="property-panel">
            <PropertyRow label="Status"><span className={`status-chip state-${ticket.status}`}>{ticket.statusLabel}</span></PropertyRow>
            <PropertyRow label="Assignee">
              <select value={ticket.assigneeAgentId || ""} onChange={(event) => onPatch(ticket.id, { assigneeAgentId: event.target.value || null })}>
                <option value="">No assignee</option>
                {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </PropertyRow>
            <PropertyRow label="Project">
              {ticket.projectId && onOpenProject ? (
                <button type="button" className="property-link link-button" onClick={() => onOpenProject(ticket.projectId)}>
                  {ticket.project?.name || "Unknown"}
                </button>
              ) : <span>{ticket.project?.name || "Unknown"}</span>}
            </PropertyRow>
            <PropertyRow label="Parent"><span>{ticket.parentTicketId || "No parent"}</span></PropertyRow>
            <PropertyRow label="PR">
              {ticket.prUrl ? <a className="property-link property-link-compact" href={ticket.prUrl} title={ticket.prUrl}><GitPullRequest /> <span>Open</span></a> : <span>None</span>}
            </PropertyRow>
            <PropertyRow label="Updated"><span>{timeAgo(ticket.updatedAt)}</span></PropertyRow>

            <section className="property-group">
              <h3><Tag /> Labels</h3>
              <div className="dependency-editor">
                <input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="ui, api, review" />
                <button onClick={() => onPatch(ticket.id, { labels: labels.split(",").map((item) => item.trim()).filter(Boolean) })}>Save</button>
              </div>
              {ticket.labels.length ? (
                <div className="chip-list">
                  {ticket.labels.map((label) => <span className="metadata-chip" key={label}>{label}</span>)}
                </div>
              ) : <p className="subtle-copy">No labels.</p>}
            </section>

          </aside>
        </div>
      </div>
    </section>
  );
}

function buildHandoffLines(ticket, latestComment) {
  const lines = [
    `Current state: ${ticket.statusLabel.toLowerCase()} ticket assigned to ${ticket.assignee?.name || "no one"}.`,
  ];
  if (ticket.blockedBy.length) {
    lines.push(`Blocked by: ${ticket.blockedBy.map((item) => item.id).join(", ")}.`);
  } else if (ticket.status === "todo" && !ticket.assigneeAgentId) {
    lines.push("Next action: triage and assign when an agent is ready to claim it.");
  } else if (["human_review", "pr_review"].includes(ticket.status)) {
    lines.push("Next action: review the latest agent output, then move the ticket forward or comment with corrections.");
  } else if (ticket.status === "done") {
    lines.push("Next action: no active handoff; keep this available as completed context.");
  } else {
    lines.push("Next action: continue from the latest workspace state and leave a comment with any handoff notes.");
  }
  if (latestComment) {
    lines.push(`Latest note from ${displayCommentAuthor(latestComment.author)}: ${summarizeCommentForHandoff(latestComment.body)}`);
  }
  return lines;
}

function displayCommentAuthor(author) {
  const normalized = String(author || "").trim().toLowerCase();
  if (normalized === "agent" || normalized === "assistant" || normalized === "bot") return "Agent";
  return "You";
}

function commentAuthorClass(author) {
  return displayCommentAuthor(author).toLowerCase();
}

function summarizeCommentForHandoff(body) {
  const text = String(body || "");
  if (text.includes('"type":"stream_event"') || text.includes('"session_id"') || text.includes("parent_tool_use_id")) {
    return "Agent transcript captured; review the comments below for the full handoff context.";
  }
  return truncateText(text, 180);
}

function PropertyRow({ label, children }) {
  return (
    <div className="property-row">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ConversationTimeline({ comments, runs }) {
  const timelineItems = buildConversationTimelineItems(comments, runs);
  const groups = groupConversationTimelineItems(timelineItems);
  const frameRef = useRef(null);
  const shouldStickRef = useRef(true);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !shouldStickRef.current) return;
    frame.scrollTop = frame.scrollHeight;
  }, [groups.length, groups.at(-1)?.id]);

  const handleScroll = () => {
    const frame = frameRef.current;
    if (!frame) return;
    const distanceFromBottom = frame.scrollHeight - frame.scrollTop - frame.clientHeight;
    shouldStickRef.current = distanceFromBottom < 48;
  };

  return (
    <div className="conversation-frame">
      <div className="conversation-scroll" ref={frameRef} onScroll={handleScroll}>
        <div className="comment-stack conversation-timeline">
          {groups.length ? groups.map((group) => {
            if (group.type === "comment") return <ConversationComment comment={group.comment} key={group.id} />;
            return <LiveActivityEvent event={group.event} key={group.id} />;
          }) : <EmptyPanel message="No comments yet." />}
        </div>
      </div>
    </div>
  );
}

function ConversationComment({ comment }) {
  return (
    <article className={`note note-${commentAuthorClass(comment.author)}`} key={comment.id}>
      <div className="note-header">
        <strong>{displayCommentAuthor(comment.author)}</strong>
        <time>{timeAgo(comment.createdAt)}</time>
      </div>
      {comment.metadata?.type === "diff_review" ? (
        <div className="review-metadata">
          <FileDiff />
          <span>{comment.metadata.filePath}:{comment.metadata.line || "?"}</span>
        </div>
      ) : null}
      <MarkdownText value={comment.body} />
    </article>
  );
}

function buildConversationTimelineItems(comments, runs) {
  const items = [];
  const seenComments = new Set();
  for (const comment of comments || []) {
    const id = stableCommentTimelineId(comment);
    if (seenComments.has(id)) continue;
    seenComments.add(id);
    items.push({ type: "comment", id, createdAt: comment.createdAt, comment });
  }
  const runList = Array.isArray(runs) ? runs : runs ? [runs] : [];
  const seenEvents = new Set();
  for (const run of runList) {
    const events = run?.events || [];
    const eventIdCounts = countEventIds(run, events);
    for (const [index, event] of events.entries()) {
      const id = stableRunEventTimelineId(run, event, index, eventIdCounts);
      const dedupeKey = runEventDedupeKey(run, event, id);
      if (seenEvents.has(dedupeKey)) continue;
      seenEvents.add(dedupeKey);
      items.push({ type: "event", id, createdAt: event.createdAt || run?.startedAt, event: { ...event, id } });
    }
  }
  return items.sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

function stableCommentTimelineId(comment) {
  return `comment-${comment?.id || `${comment?.createdAt || ""}-${hashText(comment?.body || "")}`}`;
}

function countEventIds(run, events) {
  const counts = new Map();
  for (const event of events || []) {
    const id = String(event?.id || `${run?.id || "run"}-${event?.kind || "event"}`);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function stableRunEventTimelineId(run, event, index, counts) {
  const runId = run?.id || "run";
  const eventId = String(event?.id || `${event?.kind || "event"}-${index + 1}`);
  const scopedId = `${runId}:${eventId}`;
  if ((counts.get(eventId) || 0) <= 1) return `event-${scopedId}`;
  return `event-${scopedId}:${index + 1}`;
}

function runEventDedupeKey(run, event, stableId) {
  const textKey = hashText(event?.text || "");
  return `${run?.id || "run"}:${event?.kind || "event"}:${event?.createdAt || ""}:${textKey}`;
}

function hashText(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}

function groupConversationTimelineItems(items) {
  const groups = [];
  for (const item of items) {
    if (item.type === "comment") {
      groups.push({ type: "comment", id: item.id, comment: item.comment, createdAt: item.createdAt });
      continue;
    }
    if (!isConversationLiveEventKind(item.event.kind)) continue;
    groups.push({ type: "event", id: item.id, event: item.event, createdAt: item.createdAt });
  }
  return groups;
}

function isConversationLiveEventKind(kind) {
  return kind === "assistant" || kind === "failed" || kind === "stopped";
}

function LiveActivity({ run }) {
  const eventGroups = groupLiveActivityEvents(run.events?.slice(-30) || []);
  return (
    <section className="live-activity">
      <div className="section-heading-row">
        <h3><CircleDot /> Agent activity</h3>
        <span className={`status-chip state-${run.status === "running" ? "in_progress" : run.status === "failed" || run.status === "interrupted" ? "blocked" : "human_review"}`}>{run.status}</span>
      </div>
      <div className="live-run-meta">
        <span>{run.agentName}</span>
        <RunningElapsed run={run} compact />
      </div>
      <div className="live-event-stack">
        {eventGroups.length ? eventGroups.map((group) => group.type === "collapsed" ? (
          <details className="live-event-group" key={group.id}>
            <summary>
              <span>Activity</span>
              <em>{group.events.length} collapsed event{group.events.length === 1 ? "" : "s"}</em>
            </summary>
            <div className="live-event-group-list">
              {group.events.map((event) => <LiveActivityEvent event={event} key={event.id} />)}
            </div>
          </details>
        ) : <LiveActivityEvent event={group.event} key={group.id} />) : <EmptyPanel message="Waiting for agent activity." />}
      </div>
    </section>
  );
}

function LiveActivityEvent({ event }) {
  const expanded = isExpandedLiveEventKind(event.kind);
  return (
    <details className={`live-event live-event-${event.kind} ${expanded ? "live-event-expanded" : "live-event-collapsed"}`} key={event.id} open={expanded}>
      <summary>
        <span>{displayLiveEventKind(event.kind)}</span>
        {!expanded ? <em>{collapseLiveEventText(event)}</em> : null}
      </summary>
      {event.kind === "assistant" ? <MarkdownText value={event.text} className="live-event-markdown" /> : <p>{event.text}</p>}
    </details>
  );
}

function PlanTab({ ticket, onStateUpdate }) {
  const [plans, setPlans] = useState(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [selectedText, setSelectedText] = useState("");
  const [selectedAnchorValue, setSelectedAnchorValue] = useState("plan");
  const selectedPlan = plans?.plan || null;
  const anchors = selectedPlan?.anchors?.length ? selectedPlan.anchors : [{ type: "plan", label: "Plan-wide" }];
  const selectedAnchor = anchors.find((anchor) => anchorKey(anchor) === selectedAnchorValue) || anchors[0];
  const planComments = (ticket.planComments || []).filter((comment) => !selectedPlan?.path || comment.planPath === selectedPlan.path);
  const openComments = planComments.filter((comment) => comment.status !== "resolved");

  const loadPlans = async (pathOverride = selectedPath) => {
    setBusy(true);
    setError("");
    try {
      const data = await fetchTicketPlans(ticket.id, pathOverride);
      setPlans(data);
      setSelectedPath(data.selectedPath || "");
      setSelectedAnchorValue("plan");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setPlans(null);
    setSelectedPath("");
    setError("");
    setCommentBody("");
    setSelectedText("");
    loadPlans("");
  }, [ticket.id]);

  const createPlan = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await createTicketPlan(ticket.id);
      if (data.state) onStateUpdate(data.state);
      const nextPath = data.plan?.plan?.path || ".context/plan.md";
      await loadPlans(nextPath);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPlanComment = async (event) => {
    event.preventDefault();
    if (!selectedPlan?.path || !commentBody.trim()) return;
    setBusy(true);
    setError("");
    try {
      const data = await addPlanComment(ticket.id, {
        planPath: selectedPlan.path,
        anchor: selectedAnchor,
        selectedText,
        body: commentBody,
      });
      if (data.state) onStateUpdate(data.state);
      setCommentBody("");
      setSelectedText("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resolveComment = async (comment) => {
    setBusy(true);
    setError("");
    try {
      const data = await updatePlanComment(ticket.id, comment.id, { status: comment.status === "resolved" ? "open" : "resolved" });
      if (data.state) onStateUpdate(data.state);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changePlan = async (event) => {
    const nextPath = event.target.value;
    setSelectedPath(nextPath);
    await loadPlans(nextPath);
  };

  const captureSelection = () => {
    const selection = window.getSelection?.().toString().trim();
    if (selection) setSelectedText(selection.slice(0, 500));
  };

  return (
    <section className="detail-tab-panel plan-tab-panel">
      <div className="data-panel plan-toolbar">
        <div>
          <h3><ClipboardList /> Plan</h3>
          <p>{selectedPlan ? `${selectedPlan.path} · ${selectedPlan.format}` : "No plan file discovered in this ticket workspace."}</p>
        </div>
        <div className="plan-actions">
          {plans?.files?.length ? (
            <select value={selectedPath} onChange={changePlan} aria-label="Plan file">
              {plans.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
            </select>
          ) : null}
          <button className="quiet-button" onClick={() => loadPlans()} disabled={busy}><RefreshCw /> Refresh</button>
          <button className="quiet-button" onClick={createPlan} disabled={busy}><Plus /> Thomas plan</button>
        </div>
      </div>
      {error ? <div className="blank-row">{error}</div> : null}
      {selectedPlan ? (
        <div className="plan-review-layout">
          <div className="plan-preview data-panel" onMouseUp={captureSelection}>
            <div className="section-heading-row">
              <h3>{selectedPlan.path}</h3>
              <span>{formatBytes(selectedPlan.bytes)}</span>
            </div>
            {selectedPlan.format === "html" ? (
              <iframe className="plan-html-frame" sandbox="" srcDoc={selectedPlan.content} title={`Plan preview for ${ticket.id}`} />
            ) : (
              <MarkdownText value={selectedPlan.content} className="plan-markdown" />
            )}
          </div>
          <aside className="plan-comment-panel data-panel">
            <div className="section-heading-row">
              <h3><MessageSquare /> Comments</h3>
              <span>{openComments.length} open</span>
            </div>
            <form className="plan-comment-form" onSubmit={submitPlanComment}>
              <label>
                <span>Anchor</span>
                <select value={selectedAnchorValue} onChange={(event) => setSelectedAnchorValue(event.target.value)}>
                  {anchors.map((anchor) => <option key={anchorKey(anchor)} value={anchorKey(anchor)}>{anchor.label || "Plan-wide"}</option>)}
                </select>
              </label>
              <label>
                <span>Selected text</span>
                <input value={selectedText} onChange={(event) => setSelectedText(event.target.value)} placeholder="Optional snippet from the plan" />
              </label>
              <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} placeholder="Comment on this plan for the next agent run" />
              <button disabled={busy || !commentBody.trim()}><MessageSquare /> Add comment</button>
            </form>
            <div className="plan-comment-list">
              {planComments.length ? planComments.map((comment) => (
                <article className={comment.status === "resolved" ? "plan-comment resolved" : "plan-comment"} key={comment.id}>
                  <div>
                    <strong>{comment.anchor?.label || (comment.anchor?.step ? `Step ${comment.anchor.step}` : "Plan-wide")}</strong>
                    <time>{timeAgo(comment.createdAt)}</time>
                  </div>
                  {comment.selectedText ? <blockquote>{comment.selectedText}</blockquote> : null}
                  <p>{comment.body}</p>
                  <button className="quiet-button" onClick={() => resolveComment(comment)}>{comment.status === "resolved" ? "Reopen" : "Resolve"}</button>
                </article>
              )) : <EmptyPanel message="No plan comments yet." />}
            </div>
          </aside>
        </div>
      ) : (
        <div className="data-panel plan-empty-state">
          <h3>No plan file found</h3>
          <p>Thomas looks for */plan.html, */plan.md, */PLAN.html, and */PLAN.md inside the ticket workspace. Create a Thomas plan to start from .context/plan.md.</p>
          <button onClick={createPlan} disabled={busy}><Plus /> Create Thomas plan</button>
        </div>
      )}
    </section>
  );
}

function anchorKey(anchor) {
  if (!anchor) return "plan";
  return [anchor.type || "plan", anchor.step || "", anchor.line || "", anchor.label || ""].join(":");
}

function groupLiveActivityEvents(events) {
  const groups = [];
  let collapsed = [];
  const flushCollapsed = () => {
    if (!collapsed.length) return;
    groups.push({ type: "collapsed", id: `collapsed-${collapsed[0].id}-${collapsed[collapsed.length - 1].id}`, events: collapsed });
    collapsed = [];
  };
  for (const event of events) {
    if (isExpandedLiveEventKind(event.kind)) {
      flushCollapsed();
      groups.push({ type: "event", id: event.id, event });
    } else {
      collapsed.push(event);
    }
  }
  flushCollapsed();
  return groups;
}

function isExpandedLiveEventKind(kind) {
  return kind === "assistant";
}

function collapseLiveEventText(event) {
  const label = displayLiveEventKind(event.kind).toLowerCase();
  if (event.kind === "tool") return "Tool call collapsed";
  if (event.kind === "stdout") return "Output collapsed";
  if (event.kind === "stderr") return "Error output collapsed";
  return `${titleCase(label)} collapsed`;
}

function displayLiveEventKind(kind) {
  if (kind === "assistant") return "Agent";
  if (kind === "thinking") return "Thinking";
  if (kind === "tool") return "Tool";
  if (kind === "stderr") return "Error";
  if (kind === "stdout") return "Output";
  return titleCase(kind || "status");
}

function DiffViewer({ ticketId, diff, reviewTarget, reviewComment, onSelectTarget, onCommentChange, onSubmit }) {
  const [openError, setOpenError] = useState("");
  const [treeQuery, setTreeQuery] = useState("");
  const [expandedTree, setExpandedTree] = useState(() => new Set());
  const filteredTreeRows = useMemo(() => {
    return buildTreeRows(diff.tree?.files || [], diff.tree?.dirs || [], expandedTree, treeQuery).slice(0, 900);
  }, [diff.tree, expandedTree, treeQuery]);
  const treeFileCount = diff.tree?.files?.length || 0;
  const visibleFileCount = filteredTreeRows.filter((row) => row.type === "file").length;

  const toggleDir = (dirPath) => {
    setExpandedTree((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const openFile = async (filePath) => {
    setOpenError("");
    try {
      await openTicketFile(ticketId, filePath);
    } catch (err) {
      setOpenError(err.message);
    }
  };

  return (
    <div className="diff-review-layout">
      <aside className="project-tree-panel">
        <div className="project-tree-header">
          <div>
            <strong>{diff.tree?.rootName || "Project"}</strong>
            <span>{visibleFileCount} shown · {treeFileCount} file{treeFileCount === 1 ? "" : "s"}</span>
          </div>
          {diff.tree?.truncated ? <span className="tree-badge">truncated</span> : null}
        </div>
        <label className="tree-filter">
          <Search />
          <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="Find file" />
        </label>
        {openError ? <div className="tree-error">{openError}</div> : null}
        <div className="project-tree">
          {filteredTreeRows.length ? filteredTreeRows.map((row) => (
            <button
              className={row.type === "dir" ? "tree-row tree-dir" : row.type === "empty" ? "tree-row tree-empty" : "tree-row tree-file"}
              key={`${row.type}-${row.path}`}
              onClick={() => row.type === "file" ? openFile(row.path) : row.type === "dir" ? toggleDir(row.path) : null}
              disabled={row.type === "empty"}
              title={row.path}
              style={{ "--depth": row.depth }}
              aria-expanded={row.type === "dir" ? row.expanded : undefined}
            >
              {row.type === "dir" ? <><ChevronDown className="tree-caret" /> <FolderOpen /></> : row.type === "empty" ? <><span className="tree-caret-spacer" /> <span className="tree-empty-mark" /></> : <><span className="tree-caret-spacer" /> <FileText /></>}
              <span>{row.name}</span>
            </button>
          )) : <EmptyPanel message={treeFileCount ? "No matching files." : "No project files found."} />}
        </div>
      </aside>

      <div className="diff-viewer">
        {diff.files.length ? diff.files.map((file) => {
          const filePath = file.newPath || file.oldPath;
          return (
            <section className="diff-file" key={filePath}>
              <div className="diff-file-header">
                <FileDiff />
                <strong>{filePath}</strong>
                <button className="quiet-button diff-open-file" onClick={() => openFile(filePath)}>Open</button>
              </div>
              {file.hunks.map((hunk) => (
                <div className="diff-hunk" key={`${filePath}-${hunk.header}`}>
                  <div className="diff-hunk-header">{hunk.header}</div>
                  {hunk.lines.map((line, index) => {
                    const lineNumber = line.newLine || line.oldLine;
                    const side = line.type === "remove" ? "old" : "new";
                    const selected = reviewTarget?.filePath === filePath && reviewTarget?.line === lineNumber && reviewTarget?.side === side;
                    return (
                      <div className={`diff-line diff-${line.type}${selected ? " selected" : ""}`} key={`${hunk.header}-${index}`}>
                        <button
                          className="diff-comment-target"
                          onClick={() => onSelectTarget({ filePath, line: lineNumber, side })}
                          title="Comment on this line"
                        >
                          +
                        </button>
                        <code>{line.oldLine || ""}</code>
                        <code>{line.newLine || ""}</code>
                        <pre>{line.content || " "}</pre>
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
          );
        }) : <EmptyPanel message="No local changes found in this project." />}
        {reviewTarget ? (
          <form className="diff-comment-form" onSubmit={onSubmit}>
            <span>{reviewTarget.filePath}:{reviewTarget.line}</span>
            <textarea value={reviewComment} onChange={(event) => onCommentChange(event.target.value)} placeholder="Leave review feedback for the agent" />
            <button><MessageSquare /> Add review comment</button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function buildTreeRows(files, dirs, expandedDirs, queryValue = "") {
  const root = { dirs: new Map(), files: new Map() };
  for (const dirPath of dirs) {
    const parts = String(dirPath || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(part);
    }
  }
  for (const filePath of files) {
    const parts = String(filePath || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(part);
    }
    node.files.set(parts[parts.length - 1], parts.join("/"));
  }

  const rows = [];
  const query = queryValue.trim().toLowerCase();
  const visit = (node, depth, parentPath = "") => {
    for (const [name, child] of Array.from(node.dirs.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      const dirPath = parentPath ? `${parentPath}/${name}` : name;
      const expanded = Boolean(query) || expandedDirs.has(dirPath);
      if (!query || dirPath.toLowerCase().includes(query) || subtreeMatches(child, query)) {
        rows.push({ type: "dir", name, path: dirPath, depth, expanded });
      }
      if (expanded) {
        const before = rows.length;
        visit(child, depth + 1, dirPath);
        if (rows.length === before && !query) {
          rows.push({ type: "empty", name: "Empty folder", path: `${dirPath}/__empty__`, depth: depth + 1 });
        }
      }
    }
    for (const [name, filePath] of Array.from(node.files.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      if (!query || filePath.toLowerCase().includes(query)) {
        rows.push({ type: "file", name, path: filePath, depth });
      }
    }
  };
  visit(root, 0);
  return rows;
}

function subtreeMatches(node, query) {
  for (const [name, child] of node.dirs) {
    if (name.toLowerCase().includes(query) || subtreeMatches(child, query)) return true;
  }
  for (const [name, filePath] of node.files) {
    if (name.toLowerCase().includes(query) || filePath.toLowerCase().includes(query)) return true;
  }
  return false;
}

function MarkdownText({ value, className = "" }) {
  const blocks = parseMarkdownBlocks(value);
  return (
    <div className={className ? `markdown-body ${className}` : "markdown-body"}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "heading") {
          return <h3 key={key}>{renderInlineMarkdown(block.text)}</h3>;
        }
        if (block.type === "code") {
          return <pre key={key}><code>{block.text}</code></pre>;
        }
        if (block.type === "list") {
          return <ul key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>)}</ul>;
        }
        return <p key={key}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function parseMarkdownBlocks(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: "list", items: list });
    list = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: heading[1] });
      continue;
    }
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (inCode) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks.length ? blocks : [{ type: "paragraph", text: "" }];
}

function renderInlineMarkdown(text) {
  const parts = String(text || "").split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^https?:\/\//.test(link[2])) {
      return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return part;
  });
}

function viewTitle(view) {
  if (view === "dashboard") return "Dashboard";
  if (view === "inbox") return "Inbox";
  if (view === "tickets") return "Tickets";
  if (view === "projects") return "Projects";
  if (view === "agents") return "Agents";
  if (view === "activity") return "Activity";
  if (view === "settings") return "Settings";
  return "Dashboard";
}

function compareTickets(a, b, sortBy) {
  if (sortBy === "created") return dateValue(b.createdAt) - dateValue(a.createdAt);
  if (sortBy === "status") return statusRank(a.status) - statusRank(b.status) || ticketNumber(a) - ticketNumber(b);
  if (sortBy === "id") return ticketNumber(a) - ticketNumber(b);
  if (sortBy === "title") return String(a.title || "").localeCompare(String(b.title || ""));
  return dateValue(b.updatedAt) - dateValue(a.updatedAt);
}

function ticketMatchesPreset(ticket, runs, preset) {
  if (preset === "in_flight") {
    return ticket.status === "in_progress" || runs.some((run) => run.status === "running" && run.ticketId === ticket.id);
  }
  if (preset === "needs_review") return ["human_review", "pr_review"].includes(ticket.status);
  if (preset === "unassigned") return ticket.status === "todo" && !ticket.assigneeAgentId;
  if (preset === "done") return ticket.status === "done";
  return true;
}

function projectIdentifier(project) {
  return project?.id || "";
}

function findProjectByIdentifier(projects, identifier) {
  if (!identifier) return null;
  const input = String(identifier).toLowerCase();
  return projects.find((project) =>
    project.id === identifier ||
    project.prefix?.toLowerCase() === input ||
    project.name?.toLowerCase() === input
  ) || null;
}

function preferredProjectAssigneeId(state, openTickets) {
  if (!state.agents.length) return "";
  const projectAssignee = openTickets.find((ticket) => ticket.assigneeAgentId)?.assigneeAgentId;
  if (projectAssignee) return projectAssignee;
  return state.agents[0].id;
}

function statusRank(status) {
  return BOARD_STATUSES.concat("cancelled").indexOf(status);
}

function ticketNumber(ticket) {
  return Number(ticket.number || String(ticket.id || "").match(/-(\d+)$/)?.[1] || 0);
}

function runningRunForTicket(runs, ticketId) {
  return runs.find((run) => run.ticketId === ticketId && run.status === "running") || null;
}

function terminalLabel(value) {
  return TERMINAL_OPTIONS.find((terminal) => terminal.value === value)?.label || "Warp";
}

function dateValue(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncateText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}...`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function titleCase(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

createRoot(document.getElementById("root")).render(<App />);
