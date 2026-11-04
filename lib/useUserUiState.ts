'use client';

import { useEffect, useRef, useState } from 'react';
import { readUserUi, writeUserUi } from '@/lib/uiStorage';

export function useUserUiState<T>(userId: string | undefined, name: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const nameRef = useRef(name);
  const restoredForRef = useRef<string | null>(null);
  nameRef.current = name;

  useEffect(() => {
    if (!userId) return;
    if (restoredForRef.current === userId) {
      setHydrated(true);
      return;
    }
    const saved = readUserUi<T>(userId, name);
    if (saved !== null && saved !== undefined) setValue(saved);
    restoredForRef.current = userId;
    setHydrated(true);
    // initial is a constant default for this hook instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, name]);

  useEffect(() => {
    if (!userId || !hydrated) return;
    writeUserUi(userId, nameRef.current, value);
  }, [userId, value, hydrated]);

  return [value, setValue] as const;
}
