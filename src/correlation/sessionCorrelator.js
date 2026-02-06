import { EventEmitter } from 'events';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Session Correlator for grouping multi-message conversations.
 * When a person sends details across multiple messages (e.g., name in one, address in another),
 * this correlator groups them together based on sender and time window.
 * 
 * Features:
 * - Groups messages from same sender within configurable time window
 * - Triggers processing on timeout or message count threshold
 * - Thread-safe message buffering
 * - Handles late-arriving messages gracefully
 */
class SessionCorrelator extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map(); // senderId -> session data
        this.timers = new Map(); // senderId -> timeout timer
        this.processedSessions = new Set(); // Track processed session IDs to prevent duplicates
        this.processedMessageIds = new Set(); // Track processed message IDs
        this.timeoutMs = config.correlation.timeoutSeconds * 1000;
        this.maxMessages = config.correlation.maxMessagesPerSession;
    }

    /**
     * Add a message to the correlation buffer
     * @param {object} message - Message from WhatsApp
     */
    addMessage(message) {
        const { senderId, senderNumber, pushName, text, timestamp, id } = message;

        // Skip if message already processed (deduplication)
        if (this.processedMessageIds.has(id)) {
            logger.debug('Skipping duplicate message', { id });
            return;
        }
        this.processedMessageIds.add(id);

        // Limit the size of processedMessageIds to prevent memory leak
        if (this.processedMessageIds.size > 10000) {
            const oldest = Array.from(this.processedMessageIds).slice(0, 5000);
            oldest.forEach(id => this.processedMessageIds.delete(id));
        }

        // Get or create session for this sender
        let session = this.sessions.get(senderId);

        if (!session) {
            session = {
                senderId,
                senderNumber,
                pushName,
                messages: [],
                startedAt: Date.now(),
                lastMessageAt: Date.now(),
            };
            this.sessions.set(senderId, session);
            logger.info('📋 New message session started', { sender: pushName, number: senderNumber });
        }

        // Add message to session
        session.messages.push({
            id,
            text,
            timestamp,
            receivedAt: Date.now(),
        });
        session.lastMessageAt = Date.now();

        logger.debug('Message added to session', {
            sender: senderNumber,
            messageCount: session.messages.length,
            text: text.substring(0, 30) + '...',
        });

        // Reset the timeout timer
        this.resetTimer(senderId);

        // Check if we've hit the message limit
        if (session.messages.length >= this.maxMessages) {
            logger.info('Message limit reached, processing session', { sender: senderNumber });
            this.processSession(senderId);
        }
    }

    /**
     * Reset the timeout timer for a sender
     * @param {string} senderId 
     */
    resetTimer(senderId) {
        // Clear existing timer
        if (this.timers.has(senderId)) {
            clearTimeout(this.timers.get(senderId));
        }

        // Set new timer
        const timer = setTimeout(() => {
            logger.info('Session timeout reached, processing', { senderId });
            this.processSession(senderId);
        }, this.timeoutMs);

        this.timers.set(senderId, timer);
    }

    /**
     * Process a session - emit the grouped messages and clean up
     * @param {string} senderId 
     */
    processSession(senderId) {
        const session = this.sessions.get(senderId);

        if (!session || session.messages.length === 0) {
            logger.debug('No messages to process for session', { senderId });
            return;
        }

        // Generate session ID
        const sessionId = `${senderId}_${session.startedAt}`;

        // Check if already processed (prevent duplicate processing)
        if (this.processedSessions.has(sessionId)) {
            logger.debug('Session already processed, skipping', { sessionId });
            this.sessions.delete(senderId);
            return;
        }

        // Mark as processed
        this.processedSessions.add(sessionId);

        // Limit processed sessions cache size
        if (this.processedSessions.size > 1000) {
            const oldest = Array.from(this.processedSessions).slice(0, 500);
            oldest.forEach(id => this.processedSessions.delete(id));
        }

        // Clear timer
        if (this.timers.has(senderId)) {
            clearTimeout(this.timers.get(senderId));
            this.timers.delete(senderId);
        }

        // Build combined message context
        const combinedText = session.messages.map(m => m.text).join('\n');

        const sessionData = {
            sessionId,
            senderId: session.senderId,
            senderNumber: session.senderNumber,
            pushName: session.pushName,
            messageCount: session.messages.length,
            combinedText,
            messages: session.messages,
            startedAt: session.startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - session.startedAt,
        };

        logger.info('📦 Session completed, ready for processing', {
            sender: session.senderNumber,
            messageCount: session.messages.length,
            duration: `${(sessionData.durationMs / 1000).toFixed(1)}s`,
            preview: combinedText.substring(0, 100) + (combinedText.length > 100 ? '...' : ''),
        });

        // Emit session for processing
        this.emit('session', sessionData);

        // Clean up session
        this.sessions.delete(senderId);
    }

    /**
     * Force process all pending sessions
     * Useful during shutdown
     */
    flushAll() {
        logger.info('Flushing all pending sessions', { count: this.sessions.size });

        for (const senderId of this.sessions.keys()) {
            this.processSession(senderId);
        }
    }

    /**
     * Get statistics about current sessions
     */
    getStats() {
        const sessions = [];
        for (const [senderId, session] of this.sessions) {
            sessions.push({
                senderId,
                senderNumber: session.senderNumber,
                messageCount: session.messages.length,
                ageMs: Date.now() - session.startedAt,
            });
        }
        return {
            activeSessions: this.sessions.size,
            sessions,
        };
    }

    /**
     * Clean up resources
     */
    destroy() {
        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.sessions.clear();
    }
}

export default new SessionCorrelator();
