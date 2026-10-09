// Test harness for the `power monitor` function node in flows.json: replays
// power readings against a job and checks when a run counts as started.
// Run: node test_power_monitor.js

const fs = require('fs');
const path = require('path');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = id => flows.find(n => n && n.id === id);
const monitorFn = new Function('msg', 'flow', 'global', 'node',
  'return (function(){ ' + byId('ac_power_monitor').func + ' })();');

// The real config, as `init config` builds it.
let cfg;
new Function('msg', 'flow', 'global', 'node', 'env',
  'return (function(){ ' + byId('ac_init_fn').func + ' })();')(
  {}, { get: () => undefined, set: (k, v) => { if (k === 'config') cfg = v; } },
  { get: () => undefined, set: () => {} },
  { warn: () => {}, status: () => {}, log: () => {}, error: () => {} },
  { get: () => undefined });
if (!cfg) { console.error('init config did not set flow.config'); process.exit(1); }

const T0 = new Date('2026-10-09T11:12:16+02:00').getTime();

// readings: [seconds after T0, watts]
function replay(state, readings) {
  const jobs = { dishwasher: {
    name: 'dishwasher', state, estimated_runtime_min: 195,
    requested_at: T0, waiting_since: T0, last_power: 0
  } };
  const flowStore = { config: cfg };
  const flow = { get: k => flowStore[k], set: (k, v) => { flowStore[k] = v; } };
  const global = { get: k => (k === 'jobs' ? jobs : undefined), set: () => {} };
  const node = { warn: () => {}, status: () => {}, log: () => {} };
  const origNow = Date.now;
  const seen = [];
  try {
    for (const [s, w] of readings) {
      Date.now = () => T0 + s * 1000;
      monitorFn({ topic: 'home/appliance/dishwasher/power', payload: w }, flow, global, node);
      const j = jobs.dishwasher;
      if (!seen.length || seen[seen.length - 1] !== j.state) seen.push(j.state);
    }
  } finally { Date.now = origNow; }
  return { job: jobs.dishwasher, states: seen };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

// 2026-10-09 11:12: inrush sample on power-on, then panel and standby.
const inrush = [[0, 38.6], [10, 2.5], [20, 2.5], [30, 2.5], [40, 0.7], [60, 0.7], [120, 0.7]];
let r = replay('requested', inrush);
check('requested: one inrush sample is not a start', r.job.state === 'requested', r.states.join(' > '));
check('requested: the unconfirmed draw is cleared', !r.job.startup_draw_since);
r = replay('deferred_wait', inrush);
check('deferred_wait: one inrush sample is not a start', r.job.state === 'deferred_wait', r.states.join(' > '));

// A real start: the pre-rinse holds ~40 W.
const real = [[0, 2.5], [10, 41], [20, 40], [30, 39], [40, 40], [50, 40], [60, 41]];
r = replay('requested', real);
check('requested: a held draw starts the run', r.job.state === 'starting_up', r.states.join(' > '));
check('requested: the run is dated from its first reading', r.job.started_at === T0 + 10000,
  new Date(r.job.started_at).toISOString());
r = replay('deferred_wait', real);
check('deferred_wait: a held draw resumes the run', r.job.state === 'running', r.states.join(' > '));
check('deferred_wait: predicted end counts from the first reading',
  r.job.predicted_end_at === T0 + 10000 + 195 * 60000);
check('deferred_wait: not confirmed before startup_confirm_sec',
  replay('deferred_wait', real.slice(0, 3)).job.state === 'deferred_wait');

// Sparse telemetry: two readings five minutes apart still confirm.
r = replay('deferred_wait', [[0, 40], [300, 40]]);
check('sparse readings confirm on the second one', r.job.state === 'running', r.states.join(' > '));

// A blip in the middle of the confirmation starts it over.
r = replay('requested', [[0, 40], [10, 2], [20, 40], [40, 40]]);
check('a dip restarts the confirmation', r.job.state === 'requested', r.states.join(' > '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
