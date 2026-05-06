import express from 'express';
import { config, BOT_ADDRESS } from './config.js';
import { record, snapshot } from './state.js';
import { runHedger, runYieldFarmer, runTriggerHunter } from './strategies.js';

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_ADDRESS, dryRun: config.dryRun }));
app.get('/agent-bot/log', (_req, res) => res.json(snapshot()));

app.listen(config.port, () => {
  record({ level: 'info', msg: `bot up on :${config.port}`, dryRun: config.dryRun, bot: BOT_ADDRESS });
});

async function safeRun(name, fn) {
  try { await fn(); }
  catch (e) { record({ level: 'error', strategy: name, error: String(e?.message || e) }); }
}

safeRun('hedger', runHedger);
safeRun('yield', runYieldFarmer);
safeRun('trigger', runTriggerHunter);

setInterval(() => safeRun('hedger', runHedger), config.tickHedger);
setInterval(() => safeRun('yield', runYieldFarmer), config.tickYield);
setInterval(() => safeRun('trigger', runTriggerHunter), config.tickTrigger);
