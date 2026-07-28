export const formatMilliseconds = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const formattedSeconds = seconds % 60;
  const formattedMinutes = minutes % 60;

  const timeArray = [];

  if (hours > 0) {
    timeArray.push(hours.toString().padStart(2, '0'));
  }

  timeArray.push(formattedMinutes.toString().padStart(2, '0'));
  timeArray.push(formattedSeconds.toString().padStart(2, '0'));

  return timeArray.join(':');
};

export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError('formatDuration expects a non-negative finite number of milliseconds');
  }

  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
