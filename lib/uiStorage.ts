const PREFIX = 'tamyr.ui.v1.';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type Envelope<T> = { v: 1; userId: string; savedAt: number; data: T };

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(userId: string, name: string) {
  return `${PREFIX}${userId}.${name}`;
}

export function readUserUi<T>(userId: string | undefined, name: string): T | null {
  if (!userId) return null;
  const raw = storage()?.getItem(keyFor(userId, name));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (!parsed || parsed.v !== 1 || parsed.userId !== userId || !parsed.data) return null;
    if (Date.now() - Number(parsed.savedAt || 0) > MAX_AGE_MS) {
      storage()?.removeItem(keyFor(userId, name));
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeUserUi<T>(userId: string | undefined, name: string, data: T) {
  if (!userId) return;
  try {
    storage()?.setItem(
      keyFor(userId, name),
      JSON.stringify({ v: 1, userId, savedAt: Date.now(), data } satisfies Envelope<T>)
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearUserUi(userId: string | undefined, name: string) {
  if (!userId) return;
  storage()?.removeItem(keyFor(userId, name));
}

export function clearAllUserUi(userId: string | undefined) {
  if (!userId) return;
  const store = storage();
  if (!store) return;
  const prefix = `${PREFIX}${userId}.`;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => store.removeItem(key));
}

export function sessionScrollStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
