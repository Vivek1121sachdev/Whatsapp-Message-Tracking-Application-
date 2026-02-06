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

        // Common greetings and noise words to filter
        this.noisePatterns = [
            /\b(hi|hello|hey|gm|morning|hey|thx|thanks)\b/i,
            /\b(namaste|pranam|shubh prabhat|kaise ho)\b/i,
            /\b(jay mataji|ram ram|sakti|om)\b/i,
            /\b(suno|bhai|ji|ok|okay|tike)\b/i
        ];
    }

    /**
     * Check if a message is purely noise/greeting
     * @param {string} text 
     */
    isNoise(text) {
        if (!text || text.length < 2) return true;
        const cleanText = text.trim().toLowerCase();
        // If message is very short and matches a noise pattern
        if (cleanText.length < 15) {
            return this.noisePatterns.some(pattern => pattern.test(cleanText));
        }
        return false;
    }

    /**
     * Identify which "slot" a message likely fills
     * @param {string} text 
     */
    identifySlot(text) {
        // Mobile pattern: 10 digits, optional +91 or 0 prefix
        const mobilePattern = /(\+91|0)?[6-9]\d{9}/;
        if (mobilePattern.test(text)) return 'mobile';

        // Name pattern: 2-3 capitalized words, or specific format
        // This is a heuristic and can be improved
        const namePattern = /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,2}$/;
        if (namePattern.test(text.trim())) return 'name';

        // Address pattern: Contains keywords or is longer
        const addressKeywords = /\b(road|st|street|apt|apartment|flat|city|dist|nagar|society|colony|landmark|near|opposite)\b/i;
        if (addressKeywords.test(text) || text.split(/\s+/).length > 5) return 'address';

        return 'unknown';
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

        // Limit the size of processedMessageIds
        if (this.processedMessageIds.size > 10000) {
            const idsArray = Array.from(this.processedMessageIds);
            const oldest = idsArray.slice(0, 5000);
            oldest.forEach(id => this.processedMessageIds.delete(id));
        }

        // Noise Filter: Ignore greetings
        if (this.isNoise(text)) {
            logger.info('Ignoring noise/greeting message', { sender: senderNumber, text });
            return;
        }

        // Identify slot
        const slot = this.identifySlot(text);

        // Get or create session for this sender
        let session = this.sessions.get(senderId);

        // Aggregator/Boundary Detection: Check for slot collision
        if (session && slot !== 'unknown' && session.slots && session.slots[slot]) {
            // We already have a high-confidence value for this slot. 
            // This is likely a new person (Aggregator scenario).
            logger.info('Slot collision detected (Aggregator), flushing old session', {
                sender: senderNumber,
                slot,
                oldValue: session.slots[slot],
                newValue: text
            });
            this.processSession(senderId);
            session = null; // Force create new session below
        }

        if (!session) {
            session = {
                senderId,
                senderNumber,
                pushName,
                messages: [],
                slots: { name: null, mobile: null, address: null },
                startedAt: Date.now(),
                lastMessageAt: Date.now(),
            };
            this.sessions.set(senderId, session);
            logger.info('📋 New message session started', { sender: pushName, number: senderNumber });
        }

        // Update slots
        if (slot !== 'unknown') {
            session.slots[slot] = text;
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
            slotDetected: slot,
            text: text.substring(0, 30) + '...',
        });

        // Check for Adaptive Timeout
        // If we have at least 2 slots filled (e.g. Name + Mobile), use shorter timeout
        const filledSlots = Object.values(session.slots).filter(v => v !== null).length;
        const isHighlyComplete = session.slots.name && session.slots.mobile;

        const adaptiveTimeoutMs = isHighlyComplete ? 10000 : // 10s if complete
            filledSlots >= 1 ? 30000 : // 30s if partial
                this.timeoutMs; // Default (120s)

        // Reset the timeout timer with adaptive logic
        this.resetTimer(senderId, adaptiveTimeoutMs);

        // Check if we've hit the message limit
        if (session.messages.length >= this.maxMessages) {
            logger.info('Message limit reached, processing session', { sender: senderNumber });
            this.processSession(senderId);
        }
    }

    /**
     * Remove a message from buffer (for Revoke/Delete)
     * @param {string} senderId 
     * @param {string} messageId 
     */
    removeMessage(senderId, messageId) {
        const session = this.sessions.get(senderId);
        if (!session) return;

        const initialCount = session.messages.length;
        session.messages = session.messages.filter(m => m.id !== messageId);

        if (session.messages.length < initialCount) {
            logger.info('Message removed from buffer (Revoked)', { senderId, messageId });

            // If session is now empty, delete it
            if (session.messages.length === 0) {
                this.sessions.delete(senderId);
                if (this.timers.has(senderId)) {
                    clearTimeout(this.timers.get(senderId));
                    this.timers.delete(senderId);
                }
            } else {
                // Re-evaluate slots if needed (optional optimization)
            }
        }
    }

    /**
     * Reset the timeout timer for a sender
     * @param {string} senderId 
     * @param {number} timeoutMs
     */
    resetTimer(senderId, timeoutMs = this.timeoutMs) {
        // Clear existing timer
        if (this.timers.has(senderId)) {
            clearTimeout(this.timers.get(senderId));
        }

        // Set new timer
        const timer = setTimeout(() => {
            logger.info('Session timeout reached, processing', { senderId });
            this.processSession(senderId);
        }, timeoutMs);

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
            const sessionsArray = Array.from(this.processedSessions);
            const oldest = sessionsArray.slice(0, 500);
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
            slots: session.slots,
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
