import express from 'express';
import { requestAudit } from './middleware/audit';
import { errorHandler } from './middleware/error';
import { pingDb } from './db/pool';
import { hasClerk, hasAnthropic, hasNango } from './config/env';
import northstar from './modules/northstar';
import connectors from './modules/connectors';
import record from './modules/record';
import consistency from './modules/consistency';
import readiness from './modules/readiness';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(requestAudit);

  app.get('/health', async (_req, res) => {
    res.json({
      status: 'ok',
      service: 'event-intelligence-platform',
      time: new Date().toISOString(),
      checks: { db: await pingDb(), clerk: hasClerk, anthropic: hasAnthropic, nango: hasNango },
    });
  });

  app.use('/api/northstar', northstar);
  app.use('/api/connectors', connectors);
  app.use('/api/record', record);
  app.use('/api/consistency', consistency);
  app.use('/api/readiness', readiness);

  app.use(errorHandler);
  return app;
}
