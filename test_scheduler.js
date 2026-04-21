// Test harness for the ac_scheduler function node in flows.json.
// Extracts the node's `func` source, wraps it in (msg, flow, global, node),
// and runs scenarios that exercise the 15-min slot logic, PV-cover, spike
// limits, deferral, and deadline override.

const fs = require('fs');
const path = require('path');

const FLOWS_PATH = path.join(__dirname, 'flows.json');
const flows = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
const sched = flows.find(n => n && n.id === 'ac_scheduler');
if (!sched) { console.error('ac_scheduler node not found'); process.exit(1); }

const fn = new Function('msg', 'flow', 'global', 'node',
  sched.func + '\nreturn typeof __ret !== "undefined" ? __ret : null;'
);
// The scheduler uses bare `return` statements, not assignments to __ret.
// new Function() captures the value of those returns. Rebuild with a wrapping
// IIFE so we get the actual return value.
const fnWrapped = new Function('msg', 'flow', 'global', 'node',
  'return (function(){ ' + sched.func + ' })();'
);

// ---- helpers ----
const SLOT_MS = 15 * 60000;
const ts = (iso) => new Date(iso).getTime();

function mkForecast(startIso, prices) {
  // prices: array of numbers, one per 15-min slot starting at startIso
  const t0 = ts(startIso);
  return prices.map((p, i) => ({ time: new Date(t0 + i * SLOT_MS).toISOString(), price: p }));
}

function makeCtx({ now, jobs, cfg, price_now, price_forecast, pv_curve, ess_pac }) {
  const flowState = {
    config: cfg,
    price_now,
    price_forecast,
    pv_forecast_by_hour: pv_curve,
  };
  const globalState = { ess: { pac: ess_pac }, jobs };
  const flow = {
    get: k => flowState[k],
    set: (k, v) => { flowState[k] = v; },
  };
  const global = {
    get: k => globalState[k],
    set: (k, v) => { globalState[k] = v; },
  };
  const node = { warn: () => {}, status: () => {}, log: () => {} };

  const origNow = Date.now;
  Date.now = () => now;

  return { flow, global, node, restore: () => { Date.now = origNow; } };
}

function runScenario(deviceName, params) {
  const ctx = makeCtx(params);
  let result;
  try {
    result = fnWrapped({ device_name: deviceName }, ctx.flow, ctx.global, ctx.node);
  } finally {
    ctx.restore();
  }
  if (!result) return { decision: 'null', reason: 'null', raw: null };
  const [switchMsg, delayMsg, statusMsg] = result;
  const status = JSON.parse(statusMsg.payload);
  return { decision: status.state, reason: status.reason, status, switchMsg, delayMsg, scheduled_at: status.scheduled_at };
}

// ---- scenario builder ----
const NOW = ts('2026-04-14T10:00:00+02:00'); // Tuesday, mid-morning

function baseDevice(overrides = {}) {
  return {
    name: 'dishwasher',
    state: 'starting_up',
    deadline: ts('2026-04-14T22:00:00+02:00'),
    estimated_runtime_min: 90,
    max_power_w: 2000,
    requested_at: NOW,
    last_power: 0,
    defer_count: 0,
    ...overrides,
  };
}

const baseCfg = { spike_limit_w: 4000, startup_w: 50, completion_w: 20, price_defer_ratio: 0.85, pv_max_w: 4500 };

// Flat 24h pv curve: zero at night, ramp 6-12, peak 12-15, ramp 15-19, zero after
const pvCurve = new Array(24).fill(0);
for (let h = 6; h <= 18; h++) {
  // simple bell: peak around 13:00
  const x = (h - 13) / 5;
  pvCurve[h] = Math.max(0, Math.round(4200 * Math.exp(-x * x)));
}

// ---- assertion helpers ----
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else      { failed++; console.log(`  FAIL  ${name}${detail ? '   -> ' + detail : ''}`); }
}

// ============================================================================
// Test 1: deadline imminent → must run now regardless of price/pv
// ============================================================================
console.log('\n[1] deadline override');
{
  const dev = baseDevice({ deadline: NOW + 30 * 60000, estimated_runtime_min: 60 });
  const r = runScenario('dishwasher', {
    now: NOW,
    jobs: { dishwasher: dev },
    cfg: baseCfg,
    price_now: 0.50,
    price_forecast: mkForecast('2026-04-14T10:00:00+02:00', new Array(48).fill(0.05)), // dirt cheap later
    pv_curve: pvCurve,
    ess_pac: 0,
  });
  check('decision == running', r.decision === 'running', `got ${r.decision}`);
  check('reason == deadline', r.reason === 'deadline', `got ${r.reason}`);
}

// ============================================================================
// Test 2: PV currently covers the load → run_now with pv_cover_now
// ============================================================================
console.log('\n[2] pv covers now');
{
  const dev = baseDevice({ max_power_w: 1500 });
  const r = runScenario('dishwasher', {
    now: NOW,
    jobs: { dishwasher: dev },
    cfg: baseCfg,
    price_now: 0.20,
    // make the future just as cheap so price doesn't push deferral
    price_forecast: mkForecast('2026-04-14T10:00:00+02:00', new Array(48).fill(0.20)),
    pv_curve: pvCurve,
    ess_pac: 3000, // > load, netGrid = 0 now
  });
  check('decision == running', r.decision === 'running', `got ${r.decision}`);
  check('reason == pv_cover_now', r.reason === 'pv_cover_now', `got ${r.reason}`);
}

// ============================================================================
// Test 3: cheaper later → defer to the cheap slot
// ============================================================================
console.log('\n[3] cheaper later');
{
  const dev = baseDevice({ max_power_w: 2000, estimated_runtime_min: 60 });
  // expensive now (0.40), cheap from 14:00 onward (0.05) — runtime 60 min so 4 slots
  const prices = [];
  const t0 = ts('2026-04-14T10:00:00+02:00');
  for (let i = 0; i < 48; i++) {
    const t = t0 + i * SLOT_MS;
    const h = new Date(t).getHours();
    prices.push({ time: new Date(t).toISOString(), price: h >= 14 ? 0.05 : 0.40 });
  }
  const r = runScenario('dishwasher', {
    now: NOW,
    jobs: { dishwasher: dev },
    cfg: baseCfg,
    price_now: 0.40,
    price_forecast: prices,
    pv_curve: new Array(24).fill(0), // no PV anywhere, force pure price decision
    ess_pac: 0,
  });
  check('decision == deferred', r.decision === 'deferred', `got ${r.decision}`);
  // Best slot should be at or after 14:00
  const startMs = new Date(r.scheduled_at).getTime();
  check('scheduled at 14:00 or later', startMs >= ts('2026-04-14T14:00:00+02:00'),
    `scheduled_at=${r.scheduled_at}`);
  check('aligned to 15-min grid', startMs % SLOT_MS === 0,
    `startMs=${startMs} % ${SLOT_MS} = ${startMs % SLOT_MS}`);
}

// ============================================================================
// Test 4: spike limit blocks running now (other device already running)
// ============================================================================
console.log('\n[4] spike limit forces deferral');
{
  // washing_machine drawing 2500W is running; dishwasher needs 2000W; PV=0
  // → otherPower+load = 4500W > spike_limit 4000W → cannot run now
  // future slots also conflict, so defer to first slot where wm finishes (we'll
  // simulate by removing wm via lower spike via... no, easier: keep wm running
  // and verify decision == deferred).
  const wm = {
    name: 'washing_machine',
    state: 'running',
    deadline: ts('2026-04-14T20:00:00+02:00'),
    estimated_runtime_min: 60,
    max_power_w: 2500,
    last_power: 2500,
    defer_count: 0,
  };
  const dw = baseDevice({ max_power_w: 2000, estimated_runtime_min: 60 });
  const r = runScenario('dishwasher', {
    now: NOW,
    jobs: { washing_machine: wm, dishwasher: dw },
    cfg: baseCfg, // spike 4000
    price_now: 0.20,
    price_forecast: mkForecast('2026-04-14T10:00:00+02:00', new Array(48).fill(0.20)),
    pv_curve: new Array(24).fill(0),
    ess_pac: 0,
  });
  // With wm "running" forever in this snapshot, no slot is viable → no_viable_slot → run_now.
  // We just want to confirm the spike check is firing. The path is run_now/no_viable_slot.
  check('reason indicates spike conflict (no_viable_slot)', r.reason === 'no_viable_slot',
    `got ${r.reason}`);
}

// ============================================================================
// Test 5: 15-min slot alignment + cost integration across price boundary
// ============================================================================
console.log('\n[5] 15-min slot picks the cheapest aligned start within an hour');
{
  // 60-min run, prices vary every 15 min within the next hour:
  //   10:00 0.30, 10:15 0.10, 10:30 0.30, 10:45 0.30, 11:00 0.30 ...
  // Best 60-min start is 10:15 (covers 10:15..11:15 → 0.10+0.30+0.30+0.30 cheapest).
  // But also 10:00 (0.30+0.10+0.30+0.30) — same total. 10:15 wins on tie because
  // it's strictly cheaper per first slot? Actually equal. Let's force a clearer win:
  //   10:00 0.30, 10:15 0.05, 10:30 0.05, 10:45 0.05, 11:00 0.30, 11:15 0.30 ...
  // Run at 10:00 = 0.30+0.05+0.05+0.05 = 0.45
  // Run at 10:15 = 0.05+0.05+0.05+0.30 = 0.45
  // Equal again. Make 11:00 even more expensive:
  //   10:00 0.30, 10:15 0.05, 10:30 0.05, 10:45 0.05, 11:00 1.00
  // Run at 10:00: 0.30+0.05+0.05+0.05 = 0.45
  // Run at 10:15: 0.05+0.05+0.05+1.00 = 1.15
  // → 10:00 wins. To force 10:15: drop the 10:00 slot.
  //   10:00 1.00, 10:15 0.05, 10:30 0.05, 10:45 0.05, 11:00 0.30
  // Run at 10:00: 1.00+0.05+0.05+0.05 = 1.15
  // Run at 10:15: 0.05+0.05+0.05+0.30 = 0.45 ← winner
  // Run at 10:30: 0.05+0.05+0.30+? = depends on 11:15 — make 11:15 0.30 too: 0.70

  const dev = baseDevice({ estimated_runtime_min: 60, max_power_w: 2000 });
  const t0 = ts('2026-04-14T10:00:00+02:00');
  const slotPrices = [1.00, 0.05, 0.05, 0.05, 0.30, 0.30, 0.30, 0.30]; // 10:00..11:45
  const prices = [];
  for (let i = 0; i < slotPrices.length; i++) {
    prices.push({ time: new Date(t0 + i * SLOT_MS).toISOString(), price: slotPrices[i] });
  }
  // Add flat expensive prices afterwards so deferral past 11:45 is uncompetitive
  for (let i = slotPrices.length; i < 48; i++) {
    prices.push({ time: new Date(t0 + i * SLOT_MS).toISOString(), price: 0.50 });
  }
  const r = runScenario('dishwasher', {
    now: NOW,
    jobs: { dishwasher: dev },
    cfg: baseCfg,
    price_now: 1.00, // current 15-min slot price
    price_forecast: prices,
    pv_curve: new Array(24).fill(0),
    ess_pac: 0,
  });
  check('decision == deferred', r.decision === 'deferred', `got ${r.decision}`);
  const expected = ts('2026-04-14T10:15:00+02:00');
  const startMs = new Date(r.scheduled_at).getTime();
  check('scheduled exactly at 10:15', startMs === expected,
    `expected ${new Date(expected).toISOString()}, got ${r.scheduled_at}`);
}

// ============================================================================
// Test 6: pv_cover_later — defer to midday when PV will cover the load
// ============================================================================
console.log('\n[6] defer for midday PV cover');
{
  // Early morning, no PV now; midday PV ~4000W; load 1800W. Prices flat so the
  // deciding factor is whether deferring to a PV-cover slot wins on cost.
  const earlyNow = ts('2026-04-14T07:00:00+02:00');
  const dev = baseDevice({
    max_power_w: 1800,
    estimated_runtime_min: 60,
    deadline: ts('2026-04-14T20:00:00+02:00'),
  });
  const t0 = earlyNow;
  const prices = [];
  for (let i = 0; i < 48; i++) {
    prices.push({ time: new Date(t0 + i * SLOT_MS).toISOString(), price: 0.20 });
  }
  const r = runScenario('dishwasher', {
    now: earlyNow,
    jobs: { dishwasher: dev },
    cfg: baseCfg,
    price_now: 0.20,
    price_forecast: prices,
    pv_curve: pvCurve, // peaks ~4200 around 13:00
    ess_pac: 0, // no PV at 07:00
  });
  check('decision == deferred', r.decision === 'deferred', `got ${r.decision}`);
  check('reason == pv_cover_later', r.reason === 'pv_cover_later', `got ${r.reason}`);
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
