export type RoomAdminStatus = {
  players: number;
  population: number | null;
  resetInMs: number;
  tickMs: number;
  maxTickMs: number;
  maxPendingTicks: number;
  eventLoopPercent: number;
  rssMiB: number;
};
