import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';

const app = createApp();
app.listen(env.PORT, () => {
  logger.info('server listening', { port: env.PORT, env: env.NODE_ENV });
});
