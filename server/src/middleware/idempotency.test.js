// Idempotency-Key handling.
//
// This guards the Full & Final PAYOUT route, so the failure it prevents is a
// second disbursement of real money. It used to be a per-process Map, which
// means a retry that landed on a different worker executed the operation
// again — the exact scenario these tests cover.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { startTestDB, stopTestDB, clearTestDB, TEST_DB_HOOK_TIMEOUT } = await import('../test-utils/testDb.js');
const { idempotency } = await import('./idempotency.js');

// Two apps over ONE database stand in for two cluster workers: they share
// nothing but Mongo, exactly like two Node processes behind a load balancer.
function makeWorker(counter, { required = false, fail = false } = {}) {
  const app = express();
  app.use(express.json());
  app.post('/pay', idempotency({ required }), (req, res) => {
    counter.calls += 1;
    if (fail) return res.status(500).json({ error: { code: 'BOOM' } });
    return res.status(200).json({ paid: true, attempt: counter.calls });
  });
  return app;
}

beforeAll(async () => { await startTestDB(); }, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => { await stopTestDB(); });
beforeEach(async () => { await clearTestDB(); });

describe('replay protection', () => {
  it('executes once and replays the stored response to a retry', async () => {
    const counter = { calls: 0 };
    const app = makeWorker(counter);

    const first = await request(app).post('/pay').set('Idempotency-Key', 'k-1').send({});
    expect(first.status).toBe(200);
    expect(first.body.attempt).toBe(1);

    const retry = await request(app).post('/pay').set('Idempotency-Key', 'k-1').send({});
    expect(retry.status).toBe(200);
    expect(retry.body.attempt).toBe(1);          // the SAME response, not a new one
    expect(retry.headers['x-cache-lookup']).toBe('IDEMPOTENT_HIT');
    expect(counter.calls, 'the handler ran twice').toBe(1);
  });

  it('replays across workers — the case the in-process store could not handle', async () => {
    const counterA = { calls: 0 };
    const counterB = { calls: 0 };
    const workerA = makeWorker(counterA);
    const workerB = makeWorker(counterB);

    const first = await request(workerA).post('/pay').set('Idempotency-Key', 'k-2').send({});
    expect(first.status).toBe(200);

    const retryElsewhere = await request(workerB).post('/pay').set('Idempotency-Key', 'k-2').send({});
    expect(retryElsewhere.status).toBe(200);
    expect(retryElsewhere.body).toEqual(first.body);
    expect(counterB.calls, 'the other worker paid a second time').toBe(0);
  });

  it('keeps different keys independent', async () => {
    const counter = { calls: 0 };
    const app = makeWorker(counter);
    await request(app).post('/pay').set('Idempotency-Key', 'a').send({});
    await request(app).post('/pay').set('Idempotency-Key', 'b').send({});
    expect(counter.calls).toBe(2);
  });

  it('keeps keys separate per company', async () => {
    const counter = { calls: 0 };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.auth = { company: req.headers['x-company'] }; next(); });
    app.post('/pay', idempotency(), (req, res) => {
      counter.calls += 1;
      res.status(200).json({ attempt: counter.calls });
    });

    await request(app).post('/pay').set('Idempotency-Key', 'same').set('X-Company', 'AlphaCo').send({});
    await request(app).post('/pay').set('Idempotency-Key', 'same').set('X-Company', 'BetaCo').send({});
    expect(counter.calls, 'one tenant key blocked another tenant').toBe(2);
  });
});

describe('failures are not remembered as answers', () => {
  it('lets a request be retried after it failed', async () => {
    const counter = { calls: 0 };
    const failing = makeWorker(counter, { fail: true });
    const first = await request(failing).post('/pay').set('Idempotency-Key', 'k-3').send({});
    expect(first.status).toBe(500);

    // A transient error must not be replayed for 24 hours — the operation has
    // to remain retryable.
    const succeeding = makeWorker(counter);
    const retry = await request(succeeding).post('/pay').set('Idempotency-Key', 'k-3').send({});
    expect(retry.status).toBe(200);
    expect(counter.calls).toBe(2);
  });
});

describe('the key itself', () => {
  it('passes straight through when no key is sent and none is required', async () => {
    const counter = { calls: 0 };
    const app = makeWorker(counter);
    expect((await request(app).post('/pay').send({})).status).toBe(200);
    expect((await request(app).post('/pay').send({})).status).toBe(200);
    expect(counter.calls).toBe(2);
  });

  it('demands a key when the route requires one', async () => {
    const counter = { calls: 0 };
    const app = makeWorker(counter, { required: true });
    const res = await request(app).post('/pay').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(counter.calls).toBe(0);
  });

  it('accepts the X-Idempotency-Key spelling too', async () => {
    const counter = { calls: 0 };
    const app = makeWorker(counter);
    await request(app).post('/pay').set('X-Idempotency-Key', 'k-4').send({});
    const retry = await request(app).post('/pay').set('X-Idempotency-Key', 'k-4').send({});
    expect(retry.headers['x-cache-lookup']).toBe('IDEMPOTENT_HIT');
    expect(counter.calls).toBe(1);
  });
});
