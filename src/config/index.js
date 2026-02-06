import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..', '..');

dotenv.config({ path: join(rootDir, '.env') });

const config = {
  // Groq LLM Configuration
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: 'llama-3.3-70b-versatile', // Best for multilingual extraction
    maxTokens: 1024,
    temperature: 0.1, // Low temperature for consistent extraction
  },

  // WhatsApp Configuration
  whatsapp: {
    allowedSender: process.env.WHATSAPP_ALLOWED_SENDER || null, // null = accept all
    sessionPath: join(rootDir, 'sessions'),
    sessionHours: parseInt(process.env.WHATSAPP_SESSION_HOURS, 10) || 15,
    reconnectInterval: 5000, // 5 seconds
    maxReconnectAttempts: 10,
  },

  // Kafka Configuration
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'whatsapp-pipeline',
    groupId: process.env.KAFKA_GROUP_ID || 'message-processors',
    topics: {
      rawMessages: 'raw-messages',
      parsedMessages: 'parsed-messages',
      deadLetter: 'dead-letter-queue',
    },
  },

  // Message Correlation
  correlation: {
    timeoutSeconds: parseInt(process.env.MESSAGE_CORRELATION_TIMEOUT_SECONDS, 10) || 120,
    maxMessagesPerSession: 10, // Force processing after 10 messages
  },

  // API Server
  server: {
    apiPort: parseInt(process.env.API_PORT, 10) || 3000,
    websocketPort: parseInt(process.env.WEBSOCKET_PORT, 10) || 3001,
  },

  // Database
  database: {
    path: process.env.DATABASE_PATH || join(rootDir, 'data', 'messages.db'),
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // Root directory for reference
  rootDir,
};

// Validate required configuration
function validateConfig() {
  const errors = [];

  if (!config.groq.apiKey) {
    errors.push('GROQ_API_KEY is required');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

validateConfig();

export default config;
