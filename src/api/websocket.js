import { WebSocketServer } from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * WebSocket server for real-time dashboard updates.
 * Broadcasts new contacts and status updates to all connected clients.
 */
class WebSocketManager {
    constructor() {
        this.wss = null;
        this.clients = new Set();
    }

    /**
     * Initialize WebSocket server
     */
    init() {
        this.wss = new WebSocketServer({
            port: config.server.websocketPort,
        });

        this.wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress;
            logger.info('Dashboard client connected', { ip: clientIp });

            this.clients.add(ws);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to WhatsApp Message Pipeline',
                timestamp: Date.now(),
            }));

            ws.on('close', () => {
                this.clients.delete(ws);
                logger.info('Dashboard client disconnected', { ip: clientIp });
            });

            ws.on('error', (error) => {
                logger.error('WebSocket error', { error: error.message });
                this.clients.delete(ws);
            });
        });

        logger.info(`✅ WebSocket server running on port ${config.server.websocketPort}`);
    }

    /**
     * Broadcast a message to all connected clients
     * @param {string} type - Message type
     * @param {object} data - Message payload
     */
    broadcast(type, data) {
        const message = JSON.stringify({
            type,
            data,
            timestamp: Date.now(),
        });

        this.clients.forEach((client) => {
            if (client.readyState === 1) { // OPEN
                client.send(message);
            }
        });

        logger.debug('WebSocket broadcast', { type, clientCount: this.clients.size });
    }

    /**
     * Broadcast new contact to dashboard
     * @param {object} contact - Parsed contact data
     */
    broadcastNewContact(contact) {
        this.broadcast('new_contact', contact);
    }

    /**
     * Broadcast status update
     * @param {string} status - Status message
     * @param {string} level - info, warning, error
     */
    broadcastStatus(status, level = 'info') {
        this.broadcast('status', { status, level });
    }

    /**
     * Broadcast WhatsApp connection status
     * @param {boolean} isConnected
     */
    broadcastWhatsAppStatus(isConnected) {
        this.broadcast('whatsapp_status', {
            connected: isConnected,
            timestamp: Date.now(),
        });
    }

    /**
     * Get connected client count
     */
    getClientCount() {
        return this.clients.size;
    }

    /**
     * Close WebSocket server
     */
    close() {
        if (this.wss) {
            this.wss.close();
            logger.info('WebSocket server closed');
        }
    }
}

export default new WebSocketManager();
