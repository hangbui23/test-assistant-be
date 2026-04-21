import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import app from './app.js';
import { logger } from './utils/logger.js';

const port = process.env.PORT || 3000;

const server = createServer(app);

server.listen(port, () => {
  logger.info(`🚀 Server listening on port ${port}`);
  logger.info(`📍 Health check: http://localhost:${port}/serverStatus`);
});

