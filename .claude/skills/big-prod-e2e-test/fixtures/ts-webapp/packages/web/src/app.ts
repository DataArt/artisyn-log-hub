import { describeUser, type User } from '@ts-webapp/core';

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function renderUserCard(user: User): string {
  return `<div class="user-card"><h2>${describeUser(user)}</h2><time>${formatDate(user.createdAt)}</time></div>`;
}

export function renderFooter(now: Date): string {
  return `<footer>Rendered on ${formatDate(now)}</footer>`;
}
