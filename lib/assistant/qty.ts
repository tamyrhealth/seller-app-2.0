export function hasMoreThan3Decimals(n: number): boolean {
  const s = String(n);
  const dot = s.indexOf('.');
  if (dot === -1) return false;
  return s.slice(dot + 1).replace(/0+$/, '').length > 3;
}

export function pricesEqual(a: number, b: number): boolean {
  return Number(Number(a).toFixed(2)) === Number(Number(b).toFixed(2));
}

export function qtyValidationError(qty: number, unit: string | null | undefined): string | null {
  if (isNaN(qty) || qty <= 0) return 'Введите корректное количество';
  if (unit === 'kg') {
    if (hasMoreThan3Decimals(qty)) return 'Для кг допускается не больше 3 знаков после запятой';
    return null;
  }
  if (!Number.isInteger(qty)) return 'Для этого товара количество должно быть целым';
  return null;
}
