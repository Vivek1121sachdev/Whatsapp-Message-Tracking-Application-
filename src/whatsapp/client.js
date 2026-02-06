import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { EventEmitter } from 'events';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * WhatsApp client using Baileys library.
 * Features:
 * - QR code display in terminal for authentication
 * - Persistent session storage (12-15+ hours)
 * - Auto-reconnection with exponential backoff
 * - Message filtering by sender
 * - Graceful disconnect handling
 */
class WhatsAppClient extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.sessionName = 'whatsapp-session';
    }

    /**
     * Initialize and connect to WhatsApp
     */
    async connect() {
        try {
            logger.info('Initializing WhatsApp connection...');

            // Get latest Baileys version
            const { version, isLatest } = await fetchLatestBaileysVersion();
            logger.info(`Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);

            // Load authentication state from disk (persistent sessions)
            const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionPath);

            // Create silent pino logger for Baileys (we use our own Winston logger)
            const baileysLogger = pino({ level: 'silent' });

            // Create WhatsApp socket
            this.socket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
                },
                printQRInTerminal: false, // We'll handle QR display ourselves
                logger: baileysLogger,
                browser: ['WhatsApp Message Pipeline', 'Chrome', '120.0.0'],
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000, // Keep connection alive
                retryRequestDelayMs: 500,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false, // Don't sync old messages
                markOnlineOnConnect: false, // Stay invisible
            });

            // Set up event handlers
            this.setupEventHandlers(saveCreds);

            return this.socket;
        } catch (error) {
            logger.error('Failed to initialize WhatsApp', { error: error.message });
            throw error;
        }
    }

    /**
     * Set up all event handlers for the WhatsApp socket
     */
    setupEventHandlers(saveCreds) {
        // Connection update handler
        this.socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Handle QR code display
            if (qr) {
                logger.info('═══════════════════════════════════════════════════════════');
                logger.info('   SCAN THIS QR CODE WITH YOUR WHATSAPP TO CONNECT   ');
                logger.info('═══════════════════════════════════════════════════════════');
                qrcode.generate(qr, { small: true });
                logger.info('═══════════════════════════════════════════════════════════');
                logger.info('Waiting for QR code scan...');
            }

            // Handle connection state changes
            if (connection === 'open') {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                logger.info('✅ WhatsApp connected successfully!');
                logger.info(`Session will persist for ${config.whatsapp.sessionHours} hours`);
                this.emit('connected');
            }

            if (connection === 'close') {
                this.isConnected = false;
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                logger.warn('WhatsApp connection closed', {
                    statusCode,
                    reason: DisconnectReason[statusCode] || 'Unknown',
                    shouldReconnect,
                });

                if (statusCode === DisconnectReason.loggedOut) {
                    logger.error('Session logged out. Please delete sessions folder and restart to re-authenticate.');
                    this.emit('loggedOut');
                } else if (shouldReconnect) {
                    this.handleReconnect();
                }
            }
        });

        // Credentials update handler - save to disk for persistence
        this.socket.ev.on('creds.update', async () => {
            await saveCreds();
            logger.debug('Credentials saved to disk');
        });

        // Message handler
        this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const message of messages) {
                await this.handleIncomingMessage(message);
            }
        });

        // Message update handler (for revokes/deletes)
        this.socket.ev.on('messages.update', async (items) => {
            for (const item of items) {
                if (item.update && item.update.message === null) {
                    // This is a common pattern for revoked messages in some Baileys versions
                    // but we also check for protocolMessage below
                }

                // Check if message was revoked
                if (item.update?.protocolMessage?.type === 0 || item.update?.message === null) {
                    const senderId = item.key.remoteJid;
                    const messageId = item.key.id;
                    logger.info('🗑️ Message revoked/deleted', { from: senderId, id: messageId });
                    this.emit('revoke', { senderId, messageId });
                }
            }
        });
    }

    /**
     * Handle incoming WhatsApp messages
     */
    async handleIncomingMessage(message) {
        try {
            // Ignore messages sent by us
            if (message.key.fromMe) return;

            // Ignore non-text messages for now
            const textContent = message.message?.conversation ||
                message.message?.extendedTextMessage?.text;

            if (!textContent) {
                logger.debug('Skipping non-text message', { type: Object.keys(message.message || {}) });
                return;
            }

            // Extract sender info
            const senderId = message.key.remoteJid;
            const senderNumber = senderId.replace('@s.whatsapp.net', '').replace('@g.us', '');
            const isGroup = senderId.endsWith('@g.us');

            // Filter by allowed sender if configured
            if (config.whatsapp.allowedSender) {
                const allowedNumber = config.whatsapp.allowedSender.replace(/[^0-9]/g, '');
                if (!senderNumber.includes(allowedNumber)) {
                    logger.debug('Message from non-allowed sender, ignoring', { sender: senderNumber });
                    return;
                }
            }

            // Create message object
            const messageData = {
                id: message.key.id,
                senderId,
                senderNumber,
                isGroup,
                text: textContent,
                timestamp: message.messageTimestamp ? Number(message.messageTimestamp) * 1000 : Date.now(),
                receivedAt: Date.now(),
                pushName: message.pushName || 'Unknown',
            };

            logger.info('📩 Message received', {
                from: messageData.pushName,
                number: messageData.senderNumber,
                preview: textContent.substring(0, 50) + (textContent.length > 50 ? '...' : ''),
            });

            // Emit message event for processing
            this.emit('message', messageData);

        } catch (error) {
            logger.error('Error processing incoming message', { error: error.message });
        }
    }

    /**
     * Handle reconnection with exponential backoff
     */
    async handleReconnect() {
        if (this.reconnectAttempts >= config.whatsapp.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached. Please restart the application.');
            this.emit('maxReconnectAttempts');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            config.whatsapp.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
            60000 // Max 1 minute delay
        );

        logger.info(`Reconnecting in ${delay / 1000} seconds... (attempt ${this.reconnectAttempts}/${config.whatsapp.maxReconnectAttempts})`);

        setTimeout(async () => {
            try {
                await this.connect();
            } catch (error) {
                logger.error('Reconnection failed', { error: error.message });
                this.handleReconnect();
            }
        }, delay);
    }

    /**
     * Gracefully disconnect from WhatsApp
     */
    async disconnect() {
        if (this.socket) {
            logger.info('Disconnecting from WhatsApp...');
            await this.socket.end();
            this.isConnected = false;
            this.emit('disconnected');
            logger.info('WhatsApp disconnected');
        }
    }

    /**
     * Check if connected
     */
    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
        };
    }
}

// Export singleton instance
export default new WhatsAppClient();
