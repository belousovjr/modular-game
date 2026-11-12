export function fpsColor(fps: number) {
  if (fps < 30) return 'red';
  if (fps < 60) return 'orange';
  if (fps < 90) return 'yellow';
  return 'green';
}
