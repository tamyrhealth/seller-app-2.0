import type { CityRevenue } from '@/lib/todaySalesDashboard';

export function adminDashboardAvgCheck(todayRevenue: number, todayOrders: number): number {
  if (!todayOrders) return 0;
  return todayRevenue / todayOrders;
}

export function sortCityRevenuesDesc(cities: CityRevenue[]): CityRevenue[] {
  return [...cities].sort((a, b) => b.revenue - a.revenue || a.city_name.localeCompare(b.city_name, 'ru'));
}

export function productQtySharePct(qty: number, maxQty: number): number {
  if (maxQty <= 0) return 0;
  return Math.max(4, Math.round((qty / maxQty) * 100));
}
