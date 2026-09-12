import type { DevicePoint, DeviceRect } from '@engine/geometry';

/** Resize in displayed coordinates, keeping the opposite corner/edge anchored. */
export function cropDrag(
  from: DevicePoint,
  to: DevicePoint,
  current: DeviceRect | null,
  handle: string | null,
  ratio: number | null,
  bounds: { width: number; height: number },
): DeviceRect {
  const horizontal = handle === 'e' || handle === 'w';
  const vertical = handle === 'n' || handle === 's';
  const anchor =
    current && handle
      ? {
          x: vertical
            ? current.x + current.width / 2
            : handle.includes('w')
              ? current.x + current.width
              : current.x,
          y: horizontal
            ? current.y + current.height / 2
            : handle.includes('n')
              ? current.y + current.height
              : current.y,
        }
      : from;
  const ax = Math.max(0, Math.min(bounds.width, anchor.x));
  const ay = Math.max(0, Math.min(bounds.height, anchor.y));
  const dx = Math.max(0, Math.min(bounds.width, to.x)) - ax;
  const dy = Math.max(0, Math.min(bounds.height, to.y)) - ay;
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  let width = vertical && current ? current.width : Math.abs(dx);
  let height = horizontal && current ? current.height : Math.abs(dy);
  if (ratio !== null) {
    if (horizontal) height = width / ratio;
    else if (vertical) width = height * ratio;
    else {
      width = Math.min(width, height * ratio);
      height = width / ratio;
    }
    const maxW = vertical ? 2 * Math.min(ax, bounds.width - ax) : sx < 0 ? ax : bounds.width - ax;
    const maxH = horizontal
      ? 2 * Math.min(ay, bounds.height - ay)
      : sy < 0
        ? ay
        : bounds.height - ay;
    const scale = Math.min(1, width > 0 ? maxW / width : 1, height > 0 ? maxH / height : 1);
    width *= scale;
    height *= scale;
  }
  return {
    x: vertical ? ax - width / 2 : sx < 0 ? ax - width : ax,
    y: horizontal ? ay - height / 2 : sy < 0 ? ay - height : ay,
    width,
    height,
  };
}
