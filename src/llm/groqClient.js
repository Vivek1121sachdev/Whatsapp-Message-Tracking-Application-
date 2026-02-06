import Groq from 'groq-sdk';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Groq LLM client for extracting structured contact information from messages.
 * Uses Llama 3.3 70B for multilingual text understanding.
 * 
 * Features:
 * - Handles multiple languages (English, Hindi, mixed)
 * - Deals with spelling mistakes and informal text
 * - Returns structured JSON with confidence scores
 * - Retry logic with exponential backoff
 */
class GroqClient {
    constructor() {
        this.client = new Groq({
            apiKey: config.groq.apiKey,
        });
        this.model = config.groq.model;
        this.maxRetries = 3;
    }

    /**
     * Build the extraction prompt
     * @param {string} messageText - Combined message text
     * @param {string} senderName - Name from WhatsApp profile
     */
    buildPrompt(messageText, senderName) {
        return `You are an AI assistant that extracts contact information from WhatsApp messages.

The messages may be in English, Hindi, Hinglish (mixed), or other Indian languages.
The text may contain spelling mistakes, grammatical errors, and informal language.
Messages may be split across multiple lines (the sender sent information in parts).

Extract the following information from the messages:
1. **Name**: The full name of the person (not the WhatsApp profile name, but from the message content)
2. **Address**: Complete address including street, city, state, pincode if available
3. **Mobile/Phone**: Phone number (may have country code, spaces, dashes)

IMPORTANT RULES:
- If the sender's WhatsApp profile name is "${senderName}", do NOT use this as the extracted name unless the message confirms it
- Extract ONLY information explicitly mentioned in the messages
- If a field is not found, set it to null
- For phone numbers, extract in standardized format (just digits, no spaces)
- Be generous in interpretation - people write informally

Return a JSON object with this exact structure:
{
  "name": "extracted name or null",
  "address": "full address or null",
  "mobile": "phone number or null",
  "confidence": 0.0 to 1.0,
  "notes": "any relevant notes about extraction"
}

---
MESSAGES TO PROCESS:
${messageText}
---

Return ONLY the JSON object, no other text.`;
    }

    /**
     * Extract contact information from message text
     * @param {object} session - Session data with combined messages
     * @returns {object} Extracted contact data
     */
    async extractContactInfo(session) {
        const { combinedText, senderNumber, pushName, sessionId } = session;

        logger.info('🤖 Calling LLM for extraction', {
            sender: senderNumber,
            textLength: combinedText.length,
            model: this.model,
        });

        let lastError = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const prompt = this.buildPrompt(combinedText, pushName);

                const startTime = Date.now();
                const completion = await this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a precise data extraction assistant. Always respond with valid JSON only.',
                        },
                        {
                            role: 'user',
                            content: prompt,
                        },
                    ],
                    temperature: config.groq.temperature,
                    max_tokens: config.groq.maxTokens,
                    response_format: { type: 'json_object' },
                });

                const responseTime = Date.now() - startTime;
                const responseText = completion.choices[0]?.message?.content;

                if (!responseText) {
                    throw new Error('Empty response from LLM');
                }

                // Parse the JSON response
                const extractedData = JSON.parse(responseText);

                logger.info('✅ LLM extraction successful', {
                    sender: senderNumber,
                    responseTime: `${responseTime}ms`,
                    confidence: extractedData.confidence,
                    hasName: !!extractedData.name,
                    hasAddress: !!extractedData.address,
                    hasMobile: !!extractedData.mobile,
                });

                // Return structured result
                return {
                    sessionId,
                    senderNumber,
                    pushName,
                    extracted: {
                        name: extractedData.name || null,
                        address: extractedData.address || null,
                        mobile: this.normalizePhoneNumber(extractedData.mobile),
                        confidence: extractedData.confidence || 0.5,
                        notes: extractedData.notes || null,
                    },
                    rawMessages: session.messages,
                    combinedText,
                    processedAt: Date.now(),
                    llmModel: this.model,
                    llmResponseTime: responseTime,
                };

            } catch (error) {
                lastError = error;
                logger.warn(`LLM extraction attempt ${attempt} failed`, {
                    error: error.message,
                    sender: senderNumber,
                });

                if (attempt < this.maxRetries) {
                    // Exponential backoff
                    const delay = Math.pow(2, attempt) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        // All retries failed
        logger.error('LLM extraction failed after all retries', {
            sender: senderNumber,
            error: lastError?.message,
        });

        // Return partial result for manual review
        return {
            sessionId,
            senderNumber,
            pushName,
            extracted: {
                name: null,
                address: null,
                mobile: null,
                confidence: 0,
                notes: `Extraction failed: ${lastError?.message}`,
            },
            rawMessages: session.messages,
            combinedText,
            processedAt: Date.now(),
            error: lastError?.message,
            status: 'failed',
        };
    }

    /**
     * Normalize phone number to standard format
     * @param {string} phone - Raw phone number
     * @returns {string|null} Normalized phone number
     */
    normalizePhoneNumber(phone) {
        if (!phone) return null;

        // Remove all non-digit characters except +
        let normalized = phone.replace(/[^\d+]/g, '');

        // Remove leading + if present
        if (normalized.startsWith('+')) {
            normalized = normalized.substring(1);
        }

        // Validate: should be 10-15 digits
        if (normalized.length < 10 || normalized.length > 15) {
            return phone; // Return original if can't normalize
        }

        return normalized;
    }
}

export default new GroqClient();
