import { Kafka, Partitioners, logLevel } from 'kafkajs';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Kafka client singleton with producer and consumer functionality.
 * Uses KafkaJS for Node.js Kafka operations.
 */
class KafkaClient {
    constructor() {
        this.kafka = new Kafka({
            clientId: config.kafka.clientId,
            brokers: config.kafka.brokers,
            logLevel: logLevel.WARN,
            retry: {
                initialRetryTime: 100,
                retries: 8,
            },
        });

        this.admin = null;
        this.producer = null;
        this.consumer = null;
        this.isProducerConnected = false;
        this.isConsumerConnected = false;
    }

    /**
     * Create topics if they don't exist
     */
    async createTopics() {
        try {
            this.admin = this.kafka.admin();
            await this.admin.connect();

            const topics = [
                { topic: config.kafka.topics.rawMessages, numPartitions: 3, replicationFactor: 1 },
                { topic: config.kafka.topics.parsedMessages, numPartitions: 3, replicationFactor: 1 },
                { topic: config.kafka.topics.deadLetter, numPartitions: 1, replicationFactor: 1 },
            ];

            await this.admin.createTopics({
                waitForLeaders: true,
                topics: topics,
            });

            logger.info('✅ Kafka topics created/verified');
            await this.admin.disconnect();
        } catch (error) {
            // Ignore "topic already exists" errors
            if (!error.message?.includes('already exists')) {
                logger.warn('Topic creation warning', { error: error.message });
            }
            if (this.admin) {
                await this.admin.disconnect().catch(() => { });
            }
        }
    }

    /**
     * Initialize Kafka producer
     */
    async initProducer() {
        if (this.isProducerConnected) {
            logger.debug('Producer already connected');
            return;
        }

        try {
            // Create topics first
            await this.createTopics();

            this.producer = this.kafka.producer({
                createPartitioner: Partitioners.LegacyPartitioner,
                allowAutoTopicCreation: true,
            });

            await this.producer.connect();
            this.isProducerConnected = true;
            logger.info('✅ Kafka producer connected');
        } catch (error) {
            logger.error('Failed to connect Kafka producer', { error: error.message });
            throw error;
        }
    }

    /**
     * Initialize Kafka consumer
     * @param {Function} messageHandler - Handler function for consumed messages
     */
    async initConsumer(messageHandler) {
        if (this.isConsumerConnected) {
            logger.debug('Consumer already connected');
            return;
        }

        try {
            this.consumer = this.kafka.consumer({
                groupId: config.kafka.groupId,
            });

            await this.consumer.connect();
            this.isConsumerConnected = true;
            logger.info('✅ Kafka consumer connected');

            // Subscribe to raw-messages topic
            await this.consumer.subscribe({
                topic: config.kafka.topics.rawMessages,
                fromBeginning: false,
            });

            // Start consuming
            await this.consumer.run({
                eachMessage: async ({ topic, partition, message }) => {
                    try {
                        const value = JSON.parse(message.value.toString());
                        logger.debug('Message consumed from Kafka', { topic, partition, key: message.key?.toString() });
                        await messageHandler(value);
                    } catch (error) {
                        logger.error('Error processing Kafka message', { error: error.message });
                        // Send to dead letter queue
                        await this.sendToDeadLetter(message, error);
                    }
                },
            });

            logger.info('Kafka consumer started listening', { topic: config.kafka.topics.rawMessages });
        } catch (error) {
            logger.error('Failed to initialize Kafka consumer', { error: error.message });
            throw error;
        }
    }

    /**
     * Send message to a topic
     * @param {string} topic - Kafka topic
     * @param {object} message - Message payload
     * @param {string} key - Optional message key for partitioning
     */
    async send(topic, message, key = null) {
        if (!this.isProducerConnected) {
            throw new Error('Kafka producer not connected');
        }

        try {
            await this.producer.send({
                topic,
                messages: [
                    {
                        key: key || message.sessionId || message.id || null,
                        value: JSON.stringify(message),
                        timestamp: Date.now().toString(),
                    },
                ],
            });

            logger.debug('Message sent to Kafka', { topic, key });
        } catch (error) {
            logger.error('Failed to send message to Kafka', { topic, error: error.message });
            throw error;
        }
    }

    /**
     * Send raw session message to Kafka
     * @param {object} session - Correlated session data
     */
    async sendRawMessage(session) {
        await this.send(config.kafka.topics.rawMessages, session, session.senderNumber);
        logger.info('📤 Raw message sent to Kafka', {
            topic: config.kafka.topics.rawMessages,
            sender: session.senderNumber,
        });
    }

    /**
     * Send parsed message to Kafka
     * @param {object} parsedData - LLM-parsed contact data
     */
    async sendParsedMessage(parsedData) {
        await this.send(config.kafka.topics.parsedMessages, parsedData, parsedData.senderNumber);
        logger.info('📤 Parsed message sent to Kafka', {
            topic: config.kafka.topics.parsedMessages,
            sender: parsedData.senderNumber,
        });
    }

    /**
     * Send failed message to dead letter queue
     * @param {object} message - Original message
     * @param {Error} error - Error that occurred
     */
    async sendToDeadLetter(message, error) {
        try {
            const deadLetterMessage = {
                originalMessage: message,
                error: error.message,
                stack: error.stack,
                timestamp: Date.now(),
            };

            await this.send(config.kafka.topics.deadLetter, deadLetterMessage);
            logger.warn('Message sent to dead letter queue', { error: error.message });
        } catch (dlqError) {
            logger.error('Failed to send to dead letter queue', { error: dlqError.message });
        }
    }

    /**
     * Disconnect all Kafka connections
     */
    async disconnect() {
        try {
            if (this.producer && this.isProducerConnected) {
                await this.producer.disconnect();
                this.isProducerConnected = false;
                logger.info('Kafka producer disconnected');
            }

            if (this.consumer && this.isConsumerConnected) {
                await this.consumer.disconnect();
                this.isConsumerConnected = false;
                logger.info('Kafka consumer disconnected');
            }
        } catch (error) {
            logger.error('Error disconnecting Kafka', { error: error.message });
        }
    }

    /**
     * Get connection status
     */
    getStatus() {
        return {
            producer: this.isProducerConnected,
            consumer: this.isConsumerConnected,
        };
    }
}

export default new KafkaClient();
