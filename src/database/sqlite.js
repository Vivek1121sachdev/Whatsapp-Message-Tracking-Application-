import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * SQLite database for persistent storage of messages and contacts.
 * Uses better-sqlite3 for synchronous, high-performance operations.
 */
class DatabaseClient {
    constructor() {
        this.db = null;
    }

    /**
     * Initialize database connection and create tables
     */
    async init() {
        try {
            // Ensure data directory exists
            const dbDir = dirname(config.database.path);
            if (!existsSync(dbDir)) {
                mkdirSync(dbDir, { recursive: true });
            }

            // Open database connection
            this.db = new Database(config.database.path);
            this.db.pragma('journal_mode = WAL'); // Better performance

            // Create tables
            this.createTables();

            logger.info('✅ Database initialized', { path: config.database.path });
        } catch (error) {
            logger.error('Failed to initialize database', { error: error.message });
            throw error;
        }
    }

    /**
     * Create required tables if they don't exist
     */
    createTables() {
        // Contacts table - stores extracted contact information
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        sender_number TEXT NOT NULL,
        push_name TEXT,
        extracted_name TEXT,
        extracted_address TEXT,
        extracted_mobile TEXT,
        confidence REAL DEFAULT 0,
        notes TEXT,
        status TEXT DEFAULT 'processed',
        raw_messages TEXT,
        combined_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

        // Create index for faster lookups
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_contacts_sender ON contacts(sender_number);
      CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
      CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
    `);

        // Raw messages table - stores all incoming messages
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        session_id TEXT,
        sender_number TEXT NOT NULL,
        push_name TEXT,
        message_text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      )
    `);

        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON raw_messages(sender_number);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON raw_messages(session_id);
    `);

        logger.debug('Database tables created/verified');
    }

    /**
     * Save a processed contact
     * @param {object} parsedData - LLM-parsed contact data
     */
    saveContact(parsedData) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO contacts (
        session_id, sender_number, push_name,
        extracted_name, extracted_address, extracted_mobile,
        confidence, notes, status,
        raw_messages, combined_text,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const now = Date.now();
        const result = stmt.run(
            parsedData.sessionId,
            parsedData.senderNumber,
            parsedData.pushName,
            parsedData.extracted?.name,
            parsedData.extracted?.address,
            parsedData.extracted?.mobile,
            parsedData.extracted?.confidence || 0,
            parsedData.extracted?.notes,
            parsedData.status || 'processed',
            JSON.stringify(parsedData.rawMessages),
            parsedData.combinedText,
            parsedData.processedAt || now,
            now
        );

        logger.debug('Contact saved to database', {
            id: result.lastInsertRowid,
            sender: parsedData.senderNumber,
        });

        return result.lastInsertRowid;
    }

    /**
     * Save a raw message
     * @param {object} message - Incoming WhatsApp message
     */
    saveRawMessage(message) {
        const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO raw_messages (
        message_id, session_id, sender_number, push_name,
        message_text, timestamp, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

        stmt.run(
            message.id,
            message.sessionId || null,
            message.senderNumber,
            message.pushName,
            message.text,
            message.timestamp,
            message.receivedAt
        );
    }

    /**
     * Get all contacts with pagination
     * @param {object} options - Query options
     */
    getContacts(options = {}) {
        const { limit = 50, offset = 0, status = null, search = null } = options;

        let query = 'SELECT * FROM contacts WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        if (search) {
            query += ' AND (extracted_name LIKE ? OR extracted_address LIKE ? OR extracted_mobile LIKE ? OR sender_number LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const stmt = this.db.prepare(query);
        const contacts = stmt.all(...params);

        // Parse raw_messages JSON
        return contacts.map(c => ({
            ...c,
            rawMessages: c.raw_messages ? JSON.parse(c.raw_messages) : [],
        }));
    }

    /**
     * Get a contact by session ID
     * @param {string} sessionId
     */
    getContactBySessionId(sessionId) {
        const stmt = this.db.prepare('SELECT * FROM contacts WHERE session_id = ?');
        const contact = stmt.get(sessionId);

        if (contact) {
            contact.rawMessages = contact.raw_messages ? JSON.parse(contact.raw_messages) : [];
        }

        return contact;
    }

    /**
     * Get contact count for statistics
     */
    getStats() {
        const totalStmt = this.db.prepare('SELECT COUNT(*) as total FROM contacts');
        const processedStmt = this.db.prepare("SELECT COUNT(*) as count FROM contacts WHERE status = 'processed'");
        const failedStmt = this.db.prepare("SELECT COUNT(*) as count FROM contacts WHERE status = 'failed'");
        const todayStmt = this.db.prepare('SELECT COUNT(*) as count FROM contacts WHERE created_at > ?');

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return {
            total: totalStmt.get().total,
            processed: processedStmt.get().count,
            failed: failedStmt.get().count,
            today: todayStmt.get(today.getTime()).count,
        };
    }

    /**
     * Update contact status
     * @param {string} sessionId
     * @param {string} status
     */
    updateContactStatus(sessionId, status) {
        const stmt = this.db.prepare('UPDATE contacts SET status = ?, updated_at = ? WHERE session_id = ?');
        stmt.run(status, Date.now(), sessionId);
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            logger.info('Database connection closed');
        }
    }
}

export default new DatabaseClient();
