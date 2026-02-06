import { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';

const WS_URL = 'ws://localhost:3001';
const API_URL = 'http://localhost:3000';

function App() {
    const [contacts, setContacts] = useState([]);
    const [stats, setStats] = useState({ total: 0, processed: 0, failed: 0, today: 0 });
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [selectedContact, setSelectedContact] = useState(null);
    const [toasts, setToasts] = useState([]);

    const { isConnected, newContacts, whatsappConnected, clearNewContacts } = useWebSocket(WS_URL);

    // Fetch contacts from API
    const fetchContacts = async () => {
        try {
            const params = new URLSearchParams();
            if (searchTerm) params.append('search', searchTerm);
            if (statusFilter) params.append('status', statusFilter);

            const response = await fetch(`${API_URL}/api/contacts?${params}`);
            const data = await response.json();

            if (data.success) {
                setContacts(data.data);
                setStats(data.meta);
            }
        } catch (error) {
            console.error('Failed to fetch contacts:', error);
            addToast('Failed to fetch contacts', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Initial load and search/filter changes
    useEffect(() => {
        fetchContacts();
    }, [searchTerm, statusFilter]);

    // Handle new contacts from WebSocket
    useEffect(() => {
        if (newContacts.length > 0) {
            setContacts(prev => {
                // Create a Set of existing identifiers (session_id and sender_number)
                const existingSessionIds = new Set(prev.map(c => c.session_id || c.sessionId));
                const existingSenderNumbers = new Set(prev.map(c => c.sender_number || c.senderNumber));

                // Filter new contacts that are truly unique (not already in the list)
                const uniqueNew = newContacts.filter(c => {
                    const sessionId = c.session_id || c.sessionId;
                    const senderNumber = c.sender_number || c.senderNumber;

                    // Skip if session ID already exists
                    if (existingSessionIds.has(sessionId)) {
                        return false;
                    }

                    // Also check if we already have a recent entry from same sender
                    // (within last 5 seconds) to prevent rapid duplicates
                    return true;
                });

                if (uniqueNew.length === 0) {
                    return prev; // No changes
                }

                return [...uniqueNew.map(c => ({ ...c, isNew: true })), ...prev];
            });

            // Only update stats for truly new contacts (we'll refetch to be accurate)
            fetchContacts();

            // Show toast notification for first new contact only
            if (newContacts.length > 0) {
                const contact = newContacts[0];
                const name = contact.extracted?.name || contact.extracted_name || 'Unknown';
                addToast(`New contact: ${name}`, 'success');
            }

            clearNewContacts();
        }
    }, [newContacts, clearNewContacts]);

    // Toast notifications
    const addToast = (message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 5000);
    };

    // Format timestamp
    const formatDate = (timestamp) => {
        if (!timestamp) return 'N/A';
        const date = new Date(timestamp);
        return date.toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    // Get confidence color class
    const getConfidenceClass = (confidence) => {
        if (confidence >= 0.7) return 'confidence-high';
        if (confidence >= 0.4) return 'confidence-medium';
        return 'confidence-low';
    };

    return (
        <div className="app">
            {/* Header */}
            <header className="header">
                <div className="header-left">
                    <h1 className="logo">📱 WhatsApp Pipeline</h1>
                    <div className="connection-status">
                        <span className={`status-dot ${whatsappConnected ? 'connected' : 'disconnected'}`}></span>
                        <span>WhatsApp: {whatsappConnected ? 'Connected' : 'Disconnected'}</span>
                    </div>
                    <div className="connection-status">
                        <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
                        <span>Dashboard: {isConnected ? 'Live' : 'Offline'}</span>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="main-content">
                {/* Stats Grid */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <div className="stat-label">Total Contacts</div>
                        <div className="stat-value">{stats.total}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Processed</div>
                        <div className="stat-value">{stats.processed}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Failed</div>
                        <div className="stat-value">{stats.failed}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Today</div>
                        <div className="stat-value">{stats.today}</div>
                    </div>
                </div>

                {/* Search & Filter */}
                <div className="search-bar">
                    <input
                        type="text"
                        className="search-input"
                        placeholder="🔍 Search by name, address, or mobile..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                    <select
                        className="filter-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                    >
                        <option value="">All Status</option>
                        <option value="processed">Processed</option>
                        <option value="failed">Failed</option>
                        <option value="low_confidence">Low Confidence</option>
                    </select>
                </div>

                {/* Contacts Table */}
                <section className="contacts-section">
                    <div className="section-header">
                        <h2 className="section-title">Contact Messages</h2>
                        <div className="live-badge">
                            <span className="live-dot"></span>
                            Real-time Updates
                        </div>
                    </div>

                    {loading ? (
                        <div className="loading">
                            <div className="spinner"></div>
                        </div>
                    ) : contacts.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">📭</div>
                            <div className="empty-title">No contacts yet</div>
                            <p>Waiting for WhatsApp messages...</p>
                        </div>
                    ) : (
                        <table className="contacts-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>Address</th>
                                    <th>Mobile</th>
                                    <th>Confidence</th>
                                    <th>Status</th>
                                    <th>Time</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {contacts.map((contact) => (
                                    <tr
                                        key={contact.session_id || contact.sessionId}
                                        className={contact.isNew ? 'new-contact' : ''}
                                    >
                                        <td className="contact-name">
                                            {contact.extracted_name || contact.extracted?.name || 'N/A'}
                                        </td>
                                        <td className="contact-address">
                                            {contact.extracted_address || contact.extracted?.address || 'N/A'}
                                        </td>
                                        <td className="contact-mobile">
                                            {contact.extracted_mobile || contact.extracted?.mobile || 'N/A'}
                                        </td>
                                        <td>
                                            <span className={`confidence-badge ${getConfidenceClass(contact.confidence || contact.extracted?.confidence || 0)}`}>
                                                {Math.round((contact.confidence || contact.extracted?.confidence || 0) * 100)}%
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`status-badge status-${contact.status}`}>
                                                {contact.status || 'unknown'}
                                            </span>
                                        </td>
                                        <td className="timestamp">
                                            {formatDate(contact.created_at || contact.processedAt)}
                                        </td>
                                        <td>
                                            <button
                                                className="view-btn"
                                                onClick={() => setSelectedContact(contact)}
                                            >
                                                View
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>
            </main>

            {/* Contact Detail Modal */}
            {selectedContact && (
                <div className="modal-overlay" onClick={() => setSelectedContact(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3 className="modal-title">Contact Details</h3>
                            <button className="modal-close" onClick={() => setSelectedContact(null)}>
                                ✕
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="detail-group">
                                <div className="detail-label">Name</div>
                                <div className="detail-value">
                                    {selectedContact.extracted_name || selectedContact.extracted?.name || 'Not extracted'}
                                </div>
                            </div>
                            <div className="detail-group">
                                <div className="detail-label">Address</div>
                                <div className="detail-value">
                                    {selectedContact.extracted_address || selectedContact.extracted?.address || 'Not extracted'}
                                </div>
                            </div>
                            <div className="detail-group">
                                <div className="detail-label">Mobile</div>
                                <div className="detail-value">
                                    {selectedContact.extracted_mobile || selectedContact.extracted?.mobile || 'Not extracted'}
                                </div>
                            </div>
                            <div className="detail-group">
                                <div className="detail-label">WhatsApp Sender</div>
                                <div className="detail-value">
                                    {selectedContact.push_name || selectedContact.pushName} ({selectedContact.sender_number || selectedContact.senderNumber})
                                </div>
                            </div>
                            <div className="detail-group">
                                <div className="detail-label">LLM Notes</div>
                                <div className="detail-value">
                                    {selectedContact.notes || selectedContact.extracted?.notes || 'None'}
                                </div>
                            </div>
                            <div className="detail-group">
                                <div className="detail-label">Raw Messages</div>
                                <div className="raw-messages">
                                    {(selectedContact.rawMessages || selectedContact.raw_messages || []).length > 0 ? (
                                        (typeof selectedContact.rawMessages === 'string'
                                            ? JSON.parse(selectedContact.rawMessages)
                                            : (selectedContact.rawMessages || [])
                                        ).map((msg, idx) => (
                                            <div key={idx} className="raw-message">
                                                {msg.text || msg}
                                            </div>
                                        ))
                                    ) : selectedContact.combined_text || selectedContact.combinedText ? (
                                        <div className="raw-message">
                                            {selectedContact.combined_text || selectedContact.combinedText}
                                        </div>
                                    ) : (
                                        <div className="raw-message">No raw messages available</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notifications */}
            <div className="toast-container">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`toast ${toast.type}`}>
                        {toast.type === 'success' && '✅ '}
                        {toast.type === 'error' && '❌ '}
                        {toast.message}
                    </div>
                ))}
            </div>
        </div>
    );
}

export default App;
