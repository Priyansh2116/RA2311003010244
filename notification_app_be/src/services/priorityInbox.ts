/**
 * Stage 6 — Priority Inbox
 */

export type NotificationCategory = 'Placement' | 'Result' | 'Event';

export interface RawNotification {
  ID: string;
  Type: NotificationCategory;
  Message: string;
  Timestamp: string; // "YYYY-MM-DD HH:mm:ss"
}

export interface ScoredNotification extends RawNotification {
  score: number;
}

//  Placement > Result > Event  in order
const CATEGORY_WEIGHT: Record<NotificationCategory, number> = {
  Placement: 3,
  Result: 2,
  Event: 1,
};

function minutesElapsed(timestamp: string, reference: Date): number {
  const parsed = new Date(timestamp.replace(' ', 'T'));
  return (reference.getTime() - parsed.getTime()) / 60_000;
}

// separating score computation
function calculateCompositeScore(entry: RawNotification, referenceTime: Date): number {
  const age = minutesElapsed(entry.Timestamp, referenceTime);
  const recencyBonus = 1 + 1 / (age + 1);
  return CATEGORY_WEIGHT[entry.Type] * recencyBonus;
}


// bounded min-heap  to evict the lowest-scoring item when capacity is full



class BoundedPriorityQueue {
  private readonly store: ScoredNotification[] = [];

  get count(): number {
    return this.store.length;
  }

  peekMinimum(): ScoredNotification | undefined {
    return this.store[0];
  }

  insert(candidate: ScoredNotification): void {
    this.store.push(candidate);
    this.floatUp(this.store.length - 1);
  }

  extractMinimum(): ScoredNotification | undefined {
    if (this.store.length === 0) return undefined;

    const root = this.store[0];
    const tail = this.store.pop()!;

    // Only re-heap when elements remain after the pop
    if (this.store.length > 0) {
      this.store[0] = tail;
      this.sinkDown(0);
    }

    return root;
  }

  drainDescending(): ScoredNotification[] {
    const extracted: ScoredNotification[] = [];
    while (this.store.length > 0) extracted.push(this.extractMinimum()!);
    // Reverse so callers receive highest-score first
    return extracted.reverse();
  }

  private floatUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parentIdx = (current - 1) >> 1;
      if (this.store[parentIdx].score <= this.store[current].score) break;
      [this.store[parentIdx], this.store[current]] = [this.store[current], this.store[parentIdx]];
      current = parentIdx;
    }
  }

  private sinkDown(index: number): void {
    const length = this.store.length;
    let current = index;

    while (true) {
      const left = 2 * current + 1;
      const right = 2 * current + 2;
      let smallest = current;

      if (left < length && this.store[left].score < this.store[smallest].score) smallest = left;
      if (right < length && this.store[right].score < this.store[smallest].score) smallest = right;
      if (smallest === current) break;

      [this.store[smallest], this.store[current]] = [this.store[current], this.store[smallest]];
      current = smallest;
    }
  }
}

export function extractHighValueNotifications(
  notifications: RawNotification[],
  topCount: number,
  referenceTime: Date = new Date(),
): ScoredNotification[] {
  const priorityQueue = new BoundedPriorityQueue();

  let idx = 0;
  while (idx < notifications.length) {
    const entry = notifications[idx];
    const scored: ScoredNotification = {
      ...entry,
      score: calculateCompositeScore(entry, referenceTime),
    };

    const queueFull = priorityQueue.count >= topCount;
    const currentMinimum = priorityQueue.peekMinimum();

    switch (true) {
      case !queueFull:
        priorityQueue.insert(scored);
        break;
      case queueFull && currentMinimum !== undefined && scored.score > currentMinimum.score:
        priorityQueue.extractMinimum();
        priorityQueue.insert(scored);
        break;
      // Score too low — discard silently
    }

    idx++;
  }

  return priorityQueue.drainDescending();
}

// Backward-compatible alias used by existing service and runner files
export { extractHighValueNotifications as getTopNPriority };
