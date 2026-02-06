import logger from '../utils/logger.js';
import kafkaClient from '../kafka/client.js';
import groqClient from '../llm/groqClient.js';
import database from '../database/sqlite.js';
import websocket from '../api/websocket.js';

/**
 * Message processor that consumes from Kafka, processes with LLM, and stores results.
 * This is the core processing pipeline.
 */
class MessageProcessor {
    constructor() {
        this.isRunning = false;
    }

    /**
     * Process a session from Kafka
     * @param {object} session - Correlated session data
     */
    async process(session) {
        const { sessionId, senderNumber, messageCount } = session;

        logger.info('🔄 Processing session', {
            sessionId,
            sender: senderNumber,
            messageCount,
        });

        try {
            // Extract contact info using LLM
            const parsedData = await groqClient.extractContactInfo(session);

            // Determine status based on extraction result
            if (parsedData.error) {
                parsedData.status = 'failed';
            } else if (parsedData.extracted.confidence < 0.3) {
                parsedData.status = 'low_confidence';
            } else {
                parsedData.status = 'processed';
            }

            // Save to database
            const contactId = database.saveContact(parsedData);
            logger.info('💾 Contact saved', { contactId, sessionId });

            // Send to parsed-messages topic
            await kafkaClient.sendParsedMessage(parsedData);

            // Broadcast to dashboard via WebSocket
            websocket.broadcastNewContact({
                ...parsedData,
                id: contactId,
            });

            logger.info('✅ Session processing complete', {
                sessionId,
                name: parsedData.extracted.name,
                mobile: parsedData.extracted.mobile,
                confidence: parsedData.extracted.confidence,
            });

            return parsedData;

        } catch (error) {
            logger.error('❌ Session processing failed', {
                sessionId,
                error: error.message,
            });

            // Create failed entry
            const failedData = {
                sessionId,
                senderNumber: session.senderNumber,
                pushName: session.pushName,
                extracted: {
                    name: null,
                    address: null,
                    mobile: null,
                    confidence: 0,
                    notes: `Processing error: ${error.message}`,
                },
                rawMessages: session.messages,
                combinedText: session.combinedText,
                processedAt: Date.now(),
                error: error.message,
                status: 'failed',
            };

            // Save failed entry
            database.saveContact(failedData);

            // Send to dead letter queue
            await kafkaClient.sendToDeadLetter(session, error);

            // Broadcast failure
            websocket.broadcastStatus(`Failed to process message from ${session.senderNumber}`, 'error');

            throw error;
        }
    }

    /**
     * Start the Kafka consumer for processing
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Message processor already running');
            return;
        }

        logger.info('Starting message processor...');

        await kafkaClient.initConsumer(async (session) => {
            await this.process(session);
        });

        this.isRunning = true;
        logger.info('✅ Message processor started');
    }

    /**
     * Stop the processor
     */
    async stop() {
        this.isRunning = false;
        logger.info('Message processor stopped');
    }
}

export default new MessageProcessor();
