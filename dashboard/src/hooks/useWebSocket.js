import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Custom hook for WebSocket connection with auto-reconnect
 * @param {string} url - WebSocket server URL
 * @returns {object} - Connection state and data
 */
export function useWebSocket(url) {
    const [isConnected, setIsConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState(null);
    const [newContacts, setNewContacts] = useState([]);
    const [whatsappConnected, setWhatsappConnected] = useState(false);
    const wsRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);

    const connect = useCallback(() => {
        try {
            wsRef.current = new WebSocket(url);

            wsRef.current.onopen = () => {
                console.log('WebSocket connected');
                setIsConnected(true);
            };

            wsRef.current.onclose = () => {
                console.log('WebSocket disconnected');
                setIsConnected(false);

                // Auto-reconnect after 3 seconds
                reconnectTimeoutRef.current = setTimeout(() => {
                    console.log('Attempting to reconnect...');
                    connect();
                }, 3000);
            };

            wsRef.current.onerror = (error) => {
                console.error('WebSocket error:', error);
            };

            wsRef.current.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    setLastMessage(message);

                    // Handle different message types
                    switch (message.type) {
                        case 'new_contact':
                            setNewContacts(prev => [message.data, ...prev]);
                            break;
                        case 'whatsapp_status':
                            setWhatsappConnected(message.data.connected);
                            break;
                        case 'connected':
                            console.log('WebSocket welcome:', message.message);
                            break;
                        default:
                            console.log('Unknown message type:', message.type);
                    }
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
        }
    }, [url]);

    useEffect(() => {
        connect();

        return () => {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [connect]);

    // Clear new contacts after they're acknowledged
    const clearNewContacts = useCallback(() => {
        setNewContacts([]);
    }, []);

    return {
        isConnected,
        lastMessage,
        newContacts,
        whatsappConnected,
        clearNewContacts,
    };
}
