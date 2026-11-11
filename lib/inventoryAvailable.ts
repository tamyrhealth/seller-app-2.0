export function availableQty(onHand: number, reserved = 0): number {
  const physical = Number(onHand) || 0;
  const hold = Number(reserved) || 0;
  return Math.max(0, physical) - Math.max(0, hold);
}
