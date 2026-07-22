export const DEFAULT_ROW_ESTIMATE = 3;

export type HeightCacheKey = `${string}:${number}`;

export function heightCacheKey(messageId: string, columns: number): HeightCacheKey {
  return `${messageId}:${columns}`;
}

export class MessageHeightCache {
  private readonly heights = new Map<HeightCacheKey, number>();

  get(messageId: string, columns: number): number | undefined {
    return this.heights.get(heightCacheKey(messageId, columns));
  }

  set(messageId: string, columns: number, height: number): void {
    if (height > 0) {
      this.heights.set(heightCacheKey(messageId, columns), height);
    }
  }

  delete(messageId: string): void {
    for (const key of this.heights.keys()) {
      if (key.startsWith(`${messageId}:`)) {
        this.heights.delete(key);
      }
    }
  }

  prune(validIds: ReadonlySet<string>): void {
    for (const key of this.heights.keys()) {
      const messageId = key.slice(0, key.lastIndexOf(":"));
      if (!validIds.has(messageId)) {
        this.heights.delete(key);
      }
    }
  }

  scaleColumns(oldColumns: number, newColumns: number): void {
    if (oldColumns <= 0 || oldColumns === newColumns) {
      return;
    }

    const ratio = oldColumns / newColumns;
    const next = new Map<HeightCacheKey, number>();
    for (const [key, height] of this.heights) {
      const columns = Number(key.slice(key.lastIndexOf(":") + 1));
      if (columns === oldColumns) {
        next.set(heightCacheKey(key.slice(0, key.lastIndexOf(":")), newColumns), Math.max(1, Math.round(height * ratio)));
      } else {
        next.set(key, height);
      }
    }
    this.heights.clear();
    for (const [key, height] of next) {
      this.heights.set(key, height);
    }
  }

  estimate(messageId: string, columns: number): number {
    return this.get(messageId, columns) ?? DEFAULT_ROW_ESTIMATE;
  }
}

export function buildOffsets(
  itemIds: readonly string[],
  columns: number,
  cache: MessageHeightCache,
): Float64Array {
  const offsets = new Float64Array(itemIds.length + 1);
  for (let index = 0; index < itemIds.length; index += 1) {
    offsets[index + 1] = offsets[index]! + cache.estimate(itemIds[index]!, columns);
  }
  return offsets;
}
