import express from 'express';
import cors from 'cors';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import database from '../database/sqlite.js';
import whatsappClient from '../whatsapp/client.js';
import sessionCorrelator from '../correlation/sessionCorrelator.js';
import kafkaClient from '../kafka/client.js';

const router = express.Router();

/**
 * Express API server for dashboard and health checks.
 */
class APIServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
            logger.debug(`${req.method} ${req.path}`, {
                query: req.query,
                ip: req.ip,
            });
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            const whatsappStatus = whatsappClient.getConnectionStatus();
            const kafkaStatus = kafkaClient.getStatus();
            const correlatorStats = sessionCorrelator.getStats();

            res.json({
                status: 'healthy',
                timestamp: Date.now(),
                services: {
                    whatsapp: {
                        connected: whatsappStatus.isConnected,
                        reconnectAttempts: whatsappStatus.reconnectAttempts,
                    },
                    kafka: kafkaStatus,
                    correlator: correlatorStats,
                },
            });
        });

        // Get all contacts with filtering and pagination
        this.app.get('/api/contacts', (req, res) => {
            try {
                const { limit = 50, offset = 0, status, search } = req.query;

                const contacts = database.getContacts({
                    limit: parseInt(limit, 10),
                    offset: parseInt(offset, 10),
                    status,
                    search,
                });

                const stats = database.getStats();

                res.json({
                    success: true,
                    data: contacts,
                    meta: {
                        limit: parseInt(limit, 10),
                        offset: parseInt(offset, 10),
                        ...stats,
                    },
                });
            } catch (error) {
                logger.error('Error fetching contacts', { error: error.message });
                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        // Get a specific contact
        this.app.get('/api/contacts/:sessionId', (req, res) => {
            try {
                const contact = database.getContactBySessionId(req.params.sessionId);

                if (!contact) {
                    return res.status(404).json({
                        success: false,
                        error: 'Contact not found',
                    });
                }

                res.json({
                    success: true,
                    data: contact,
                });
            } catch (error) {
                logger.error('Error fetching contact', { error: error.message });
                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        // Update contact status
        this.app.patch('/api/contacts/:sessionId/status', (req, res) => {
            try {
                const { status } = req.body;

                if (!['processed', 'reviewed', 'failed', 'archived'].includes(status)) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid status',
                    });
                }

                database.updateContactStatus(req.params.sessionId, status);

                res.json({
                    success: true,
                    message: 'Status updated',
                });
            } catch (error) {
                logger.error('Error updating contact status', { error: error.message });
                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        // Get statistics
        this.app.get('/api/stats', (req, res) => {
            try {
                const stats = database.getStats();
                const whatsappStatus = whatsappClient.getConnectionStatus();
                const correlatorStats = sessionCorrelator.getStats();

                res.json({
                    success: true,
                    data: {
                        contacts: stats,
                        whatsapp: whatsappStatus,
                        correlator: correlatorStats,
                    },
                });
            } catch (error) {
                logger.error('Error fetching stats', { error: error.message });
                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Not found',
            });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            logger.error('API error', { error: err.message });
            res.status(500).json({
                success: false,
                error: 'Internal server error',
            });
        });
    }

    /**
     * Start the API server
     */
    async start() {
        return new Promise((resolve) => {
            this.server = this.app.listen(config.server.apiPort, () => {
                logger.info(`✅ API server running on http://localhost:${config.server.apiPort}`);
                resolve();
            });
        });
    }

    /**
     * Stop the API server
     */
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    logger.info('API server stopped');
                    resolve();
                });
            });
        }
    }
}

export default new APIServer();
