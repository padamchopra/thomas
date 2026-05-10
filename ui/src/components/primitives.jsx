import { useEffect, useState } from "react";
import { AlertTriangle, Clock, MessageSquare, Network } from "lucide-react";

export function SidebarSection({ label, children }) {
  return (
    <div className="nav-group">
      <div className="nav-heading">{label}</div>
      <div className="nav-stack">{children}</div>
    </div>
  );
}

export function SidebarNavItem({ active, icon: Icon, label, onClick, badge }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      <Icon />
      <span className="nav-label">{label}</span>
      {badge !== undefined && badge !== null ? <span className="nav-badge">{badge}</span> : null}
    </button>
  );
}

export function StatusIcon({ status }) {
  return <span className={`status-ring state-${status}`} title={status.replaceAll("_", " ")} />;
}

export function Identity({ name }) {
  if (!name) return <span className="assignee-pill assignee-empty">Unassigned</span>;
  return <span className="assignee-pill"><span>{name.slice(0, 1).toUpperCase()}</span>{name}</span>;
}

export function IssueRow({ ticket, onOpenTicket, compact = false, run = null }) {
  return (
    <button className={compact ? "issue-row-compact" : "issue-row"} onClick={() => onOpenTicket(ticket.id)}>
      {compact ? (
        <>
          <span><StatusIcon status={ticket.status} /><strong>{ticket.id}</strong>{ticket.title}</span>
          <small>{ticket.statusLabel} · {ticket.assignee?.name || "Unassigned"}<RunningElapsed run={run} compact /></small>
        </>
      ) : (
        <>
          <span className="issue-title">
            <span className="issue-main-line"><StatusIcon status={ticket.status} /><strong>{ticket.id}</strong><span>{ticket.title}</span></span>
            <span className="issue-sub-line">
              <span>{ticket.statusLabel}</span>
              {ticket.comments.length > 0 && <span>{ticket.comments.length} comments</span>}
              {ticket.children.length > 0 && <span>{ticket.children.length} sub-issues</span>}
              {ticket.blockedBy.length > 0 && <span>{ticket.blockedBy.length} blockers</span>}
              {ticket.labels?.slice(0, 2).map((label) => <span className="metadata-chip" key={label}>{label}</span>)}
              <RunningElapsed run={run} />
            </span>
          </span>
          <span>{ticket.assignee?.name || "Unassigned"}</span>
          <span>{ticket.project?.name || "Unknown"}</span>
          <span>{timeAgo(ticket.updatedAt)}</span>
        </>
      )}
    </button>
  );
}

export function KanbanBoard({ statuses, tickets, statusLabel, onOpenTicket, runs = [] }) {
  const populatedStatuses = statuses.filter((status) => tickets.some((ticket) => ticket.status === status));
  const visibleStatuses = populatedStatuses.length > 0 ? populatedStatuses : statuses;
  return (
    <section className="issue-board">
      {visibleStatuses.map((status) => {
        const columnTickets = tickets.filter((ticket) => ticket.status === status);
        return (
          <div className="lane" key={status}>
            <div className="lane-header">
              <span className="lane-title"><StatusIcon status={status} /> <strong>{statusLabel(status)}</strong></span>
              <span>{columnTickets.length}</span>
            </div>
            {columnTickets.length === 0 ? <div className="lane-placeholder" /> : null}
            {columnTickets.map((ticket) => (
              <IssueCard key={ticket.id} ticket={ticket} run={runningRunForTicket(runs, ticket.id)} onOpenTicket={onOpenTicket} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

export function IssueCard({ ticket, onOpenTicket, run = null }) {
  const isDone = ticket.status === "done";
  return (
    <article className={`task-card${isDone ? " task-card-complete" : ""}`}>
      <button
        className="card-button"
        onClick={() => onOpenTicket(ticket.id)}
      >
        <span className="card-head">
          <span className="task-key">{ticket.id}</span>
          <RunningElapsed run={run} compact />
        </span>
        <span className="card-title"><StatusIcon status={ticket.status} /><strong>{ticket.title}</strong></span>
        {!isDone ? (
          <>
            <span className="card-meta">
              <Identity name={ticket.assignee?.name} />
            </span>
            <span className="card-tags">
              {ticket.labels?.slice(0, 2).map((label) => <span className="metadata-chip" key={label}>{label}</span>)}
              {ticket.children.length > 0 && <Badge icon={<Network />} text={`${ticket.children.length} sub`} />}
              {ticket.blockedBy.length > 0 && <Badge icon={<AlertTriangle />} text={`${ticket.blockedBy.length} blockers`} />}
              {ticket.comments.length > 0 && <Badge icon={<MessageSquare />} text={ticket.comments.length} />}
            </span>
          </>
        ) : null}
      </button>
    </article>
  );
}

export function Badge({ icon, text }) {
  return <span className="tag">{icon}{text}</span>;
}

export function RunningElapsed({ run, compact = false }) {
  const elapsed = useElapsedLabel(run?.status === "running" ? run.startedAt : null);
  if (!elapsed) return null;
  return <span className={compact ? "elapsed-pill elapsed-pill-compact" : "elapsed-pill"}><Clock />{elapsed}</span>;
}

function useElapsedLabel(startedAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "";
  return formatElapsed(now - new Date(startedAt).getTime());
}

function runningRunForTicket(runs, ticketId) {
  return runs.find((run) => run.ticketId === ticketId && run.status === "running") || null;
}

function formatElapsed(diffMs) {
  if (!Number.isFinite(diffMs) || diffMs < 0) return "0s";
  const totalSeconds = Math.floor(diffMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function timeAgo(value) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
