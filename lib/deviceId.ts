'use client';

const STORAGE_KEY = 'seller_app_device_id';

function generateDeviceId(): string {
  const arr = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Получает device_id из localStorage или создаёт новый и сохраняет.
 * Вызывать только на клиенте (localStorage).
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(STORAGE_KEY);
    if (!id || id.length < 16) {
      id = generateDeviceId();
      window.localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    return generateDeviceId();
  }
}
