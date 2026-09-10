import { describe, it, expect } from 'vitest';
import { processInNonBlockingBatches, runTaskInBackground } from './jobQueue.js';

describe('JobQueue module tests', () => {
  it('processes items in non-blocking chunked batches', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1);
    const processedChunks = [];

    const result = await processInNonBlockingBatches(items, 3, async (chunk) => {
      processedChunks.push(chunk);
    });

    expect(result.processed).toBe(10);
    expect(result.errors).toBe(0);
    expect(processedChunks.length).toBe(4); // 3 + 3 + 3 + 1
    expect(processedChunks[0]).toEqual([1, 2, 3]);
  });

  it('handles empty items array gracefully', async () => {
    const result = await processInNonBlockingBatches([], 10, async () => {});
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('runs task in background without blocking main execution', async () => {
    let executed = false;
    runTaskInBackground('test-task', async () => {
      executed = true;
    });

    expect(executed).toBe(false); // Task is scheduled via setImmediate
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toBe(true);
  });
});
