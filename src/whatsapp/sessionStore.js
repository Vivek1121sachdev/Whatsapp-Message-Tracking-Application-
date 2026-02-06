import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Persistent session store for WhatsApp authentication.
 * Stores session data to disk to survive restarts and maintain connection for 12-15+ hours.
 */
class SessionStore {
    constructor() {
        this.sessionPath = config.whatsapp.sessionPath;
        this.ensureSessionDirectory();
    }

    ensureSessionDirectory() {
        if (!existsSync(this.sessionPath)) {
            mkdirSync(this.sessionPath, { recursive: true });
            logger.info('Created session directory', { path: this.sessionPath });
        }
    }

    getFilePath(key) {
        // Sanitize key to prevent directory traversal
        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        return join(this.sessionPath, `${safeKey}.json`);
    }

    /**
     * Read session data from disk
     * @param {string} key - Session key
     * @returns {object|null} Session data or null if not found
     */
    read(key) {
        const filePath = this.getFilePath(key);
        try {
            if (existsSync(filePath)) {
                const data = readFileSync(filePath, 'utf-8');
                return JSON.parse(data);
            }
        } catch (error) {
            logger.error('Failed to read session', { key, error: error.message });
        }
        return null;
    }

    /**
     * Write session data to disk
     * @param {string} key - Session key
     * @param {object} data - Session data to store
     */
    write(key, data) {
        const filePath = this.getFilePath(key);
        try {
            writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            logger.debug('Session data saved', { key });
        } catch (error) {
            logger.error('Failed to write session', { key, error: error.message });
            throw error;
        }
    }

    /**
     * Delete session data
     * @param {string} key - Session key
     */
    delete(key) {
        const filePath = this.getFilePath(key);
        try {
            if (existsSync(filePath)) {
                const { unlinkSync } = require('fs');
                unlinkSync(filePath);
                logger.info('Session deleted', { key });
            }
        } catch (error) {
            logger.error('Failed to delete session', { key, error: error.message });
        }
    }

    /**
     * Check if session exists
     * @param {string} key - Session key
     * @returns {boolean}
     */
    exists(key) {
        return existsSync(this.getFilePath(key));
    }
}

export default new SessionStore();
