import logger from './utils/logger.js';
import config from './config/index.js';
import whatsappClient from './whatsapp/client.js';
import sessionCorrelator from './correlation/sessionCorrelator.js';
import kafkaClient from './kafka/client.js';
import messageProcessor from './kafka/processor.js';
import database from './database/sqlite.js';
import apiServer from './api/server.js';
import websocket from './api/websocket.js';

/**
 * Main application entry point.
 * Orchestrates all components of the WhatsApp Message Pipeline.
 */
class Application {
    constructor() {
        this.isShuttingDown = false;
    }

    /**
     * Initialize and start all services
     */
    async start() {
        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║       📱 WhatsApp Message Processing Pipeline                 ║
║                                                               ║
║   Production-Ready Message Extraction System                  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

        try {
            // 1. Initialize database
            logger.info('Starting services...');
            await database.init();

            // 2. Initialize Kafka producer
            await kafkaClient.initProducer();

            // 3. Start message processor (Kafka consumer)
            await messageProcessor.start();

            // 4. Start WebSocket server for real-time updates
            websocket.init();

            // 5. Start API server
            await apiServer.start();

            // 6. Set up session correlator events
            sessionCorrelator.on('session', async (session) => {
                try {
                    // Send to Kafka for processing
                    await kafkaClient.sendRawMessage(session);
                } catch (error) {
                    logger.error('Failed to send session to Kafka', { error: error.message });
                }
            });

            // 7. Connect to WhatsApp (this will show QR code)
            whatsappClient.on('connected', () => {
                websocket.broadcastWhatsAppStatus(true);
                logger.info('🎉 System fully operational!');
                console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  ✅ SYSTEM READY                                              ║
║                                                               ║
║  📡 API Server:      http://localhost:${config.server.apiPort}                    ║
║  🔌 WebSocket:       ws://localhost:${config.server.websocketPort}                     ║
║  📊 Kafka UI:        http://localhost:8080                    ║
║  🌐 Dashboard:       http://localhost:5173 (after npm run dev)║
║                                                               ║
║  Waiting for messages...                                      ║
╚═══════════════════════════════════════════════════════════════╝
`);
            });

            whatsappClient.on('message', (message) => {
                // Add message to correlator for grouping
                sessionCorrelator.addMessage(message);

                // Save raw message to database
                database.saveRawMessage(message);
            });

            whatsappClient.on('revoke', ({ senderId, messageId }) => {
                // Remove from correlation buffer if it exists
                sessionCorrelator.removeMessage(senderId, messageId);

                // Optionally update database or notify dashboard (future enhancement)
                logger.debug('Handled message revoke in application', { senderId, messageId });
            });

            whatsappClient.on('loggedOut', () => {
                websocket.broadcastWhatsAppStatus(false);
                logger.error('WhatsApp logged out! Please restart and scan QR again.');
            });

            // Connect to WhatsApp (shows QR code in terminal)
            await whatsappClient.connect();

            // Set up graceful shutdown
            this.setupGracefulShutdown();

        } catch (error) {
            logger.error('Failed to start application', { error: error.message });
            console.error('Startup failed:', error.message);
            process.exit(1);
        }
    }

    /**
     * Set up graceful shutdown handlers
     */
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info(`Received ${signal}, starting graceful shutdown...`);
            console.log('\nShutting down gracefully...');

            try {
                // Flush any pending sessions
                sessionCorrelator.flushAll();

                // Disconnect WhatsApp
                await whatsappClient.disconnect();

                // Stop servers
                await apiServer.stop();
                websocket.close();

                // Disconnect Kafka
                await kafkaClient.disconnect();

                // Close database
                database.close();

                logger.info('Graceful shutdown completed');
                console.log('Goodbye! 👋');
                process.exit(0);

            } catch (error) {
                logger.error('Error during shutdown', { error: error.message });
                process.exit(1);
            }
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception', { error: error.message, stack: error.stack });
            shutdown('uncaughtException');
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection', { reason, promise });
        });
    }
}

// Start the application
const app = new Application();
app.start().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
