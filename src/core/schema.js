"use strict";

const TICKET_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "human_review",
  "pr_review",
  "done",
  "cancelled",
];

const STATUS_LABELS = {
  backlog: "Backlog",
  todo: "To-do",
  in_progress: "In Progress",
  blocked: "Blocked",
  human_review: "Human Review",
  pr_review: "PR Review",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITIES = ["critical", "high", "medium", "low"];

module.exports = {
  PRIORITIES,
  STATUS_LABELS,
  TICKET_STATUSES,
};
