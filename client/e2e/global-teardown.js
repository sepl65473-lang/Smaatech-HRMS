export default async function globalTeardown() {
  const ctx = globalThis.__E2E__;
  if (!ctx) return;
  for (const proc of [ctx.web, ctx.server]) {
    try { proc?.kill('SIGTERM'); } catch { /* already gone */ }
  }
  try { await ctx.replSet?.stop(); } catch { /* already stopped */ }
}
