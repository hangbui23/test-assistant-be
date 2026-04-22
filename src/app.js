import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { connectMongo } from './config/index.js';
import authRouter from './routes/auth.js';
import generationRouter from './routes/generations.js';
import { logger } from './utils/logger.js';

const app = express();

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  next();
});

// CORS Configuration
app.use(cors({ 
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000', 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'], 
}));

app.options(/.*/, cors());

// Body Parser - Parse JSON request bodies
app.use(express.json({ limit: '10mb' }));

// HTTP Request Logging
app.use(morgan('dev'));

// Health Check Endpoint
app.get('/serverStatus', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    service: 'test-assistant-be' 
  });
});

// Connect to MongoDB
connectMongo().catch((err) => {
  logger.error('Mongo connection error:', err);
  process.exit(1);
});

// Routes
app.use('/auth', authRouter);
app.use('/generations', generationRouter);

// Log registered routes
logger.info('✅ Registered routes:');
logger.info('  POST /auth/register');
logger.info('  POST /generations/generate');

// 404 Handler - Route not found
app.use((req, res) => {
  logger.info(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    success: false, 
    error: `Route not found: ${req.method} ${req.path}` 
  });
});

// Error Handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error('Error:', err);
  res.status(status).json({ 
    success: false, 
    error: err.message || 'Internal Server Error' 
  });
});

export default app;