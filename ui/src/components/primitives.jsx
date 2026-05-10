import { AlertTriangle, MessageSquare, Network } from "lucide-react";

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

export function IssueRow({ ticket, onOpenTicket, compact = false }) {
  return (
    <button className={compact ? "issue-row-compact" : "issue-row"} onClick={() => onOpenTicket(ticket.id)}>
      {compact ? (
        <>
          <span><StatusIcon status={ticket.status} /><strong>{ticket.id}</strong>{ticket.title}</span>
          <small>{ticket.statusLabel} · {ticket.assignee?.name || "Unassigned"}</small>
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

export function KanbanBoard({ statuses, tickets, statusLabel, onOpenTicket }) {
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
              <IssueCard key={ticket.id} ticket={ticket} onOpenTicket={onOpenTicket} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

export function IssueCard({ ticket, onOpenTicket }) {
  return (
    <article className="task-card">
      <button
        className="card-button"
        onClick={() => onOpenTicket(ticket.id)}
      >
        <span className="card-head">
          <span className="task-key">{ticket.id}</span>
        </span>
        <span className="card-title"><StatusIcon status={ticket.status} /><strong>{ticket.title}</strong></span>
        <span className="card-meta">
          <Identity name={ticket.assignee?.name} />
        </span>
        <span className="card-tags">
          {ticket.labels?.slice(0, 2).map((label) => <span className="metadata-chip" key={label}>{label}</span>)}
          {ticket.children.length > 0 && <Badge icon={<Network />} text={`${ticket.children.length} sub`} />}
          {ticket.blockedBy.length > 0 && <Badge icon={<AlertTriangle />} text={`${ticket.blockedBy.length} blockers`} />}
          {ticket.comments.length > 0 && <Badge icon={<MessageSquare />} text={ticket.comments.length} />}
        </span>
      </button>
    </article>
  );
}

export function Badge({ icon, text }) {
  return <span className="tag">{icon}{text}</span>;
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
