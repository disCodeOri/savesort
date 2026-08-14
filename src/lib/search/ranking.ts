export function reciprocalRank(
  rank: number | null | undefined,
  weight = 1,
  smoothingConstant = 60,
): number {
  if (rank === null || rank === undefined || rank < 1) return 0;
  return weight / (smoothingConstant + rank);
}
