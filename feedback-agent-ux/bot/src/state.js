const MAX = 200;
const ring = [];

export function record(entry) {
  const stamped = { ts: new Date().toISOString(), ...entry };
  ring.push(stamped);
  if (ring.length > MAX) ring.shift();
  console.log(JSON.stringify(stamped));
}

export function snapshot() {
  return ring.slice(-100);
}

let consecutiveErrors = 0;
let pausedUntil = 0;

export function noteOk() { consecutiveErrors = 0; }

export function noteError() {
  consecutiveErrors += 1;
  if (consecutiveErrors >= 3) {
    pausedUntil = Date.now() + 60 * 60 * 1000;
    record({ level: 'warn', msg: 'paused 1h after 3 consecutive errors' });
    consecutiveErrors = 0;
  }
}

export function isPaused() { return Date.now() < pausedUntil; }

const shieldFailures = new Map();

export function noteShieldOk(shield) { shieldFailures.delete(shield); }

export function noteShieldFail(shield) {
  const now = Date.now();
  const cur = shieldFailures.get(shield) || { count: 0, until: 0 };
  cur.count += 1;
  if (cur.count >= 5) {
    cur.until = now + 24 * 60 * 60 * 1000;
    record({ level: 'warn', msg: `shield ${shield} disabled 24h after 5 failures` });
  }
  shieldFailures.set(shield, cur);
}

export function isShieldDisabled(shield) {
  const cur = shieldFailures.get(shield);
  return Boolean(cur && Date.now() < cur.until);
}
