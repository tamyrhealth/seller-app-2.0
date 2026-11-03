import type { Role } from '@/lib/types';

export const ASSISTANT_ROLES: Role[] = ['admin', 'manager'];

export function isAssistantRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'manager';
}

export function homePathForRole(role: string | null | undefined): string {
  if (role === 'admin') return '/admin';
  if (role === 'manager') return '/manager';
  return '/seller';
}

export function roleMatches(allowed: Role | Role[] | undefined, actual: string | null | undefined): boolean {
  if (!allowed) return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return !!actual && list.includes(actual as Role);
}
