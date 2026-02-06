# WhatsApp Message Processing Pipeline

A production-ready system that receives WhatsApp messages, extracts contact information (Name, Address, Mobile) using AI/LLM, and displays them in a real-time dashboard.

---

## 🚀 Quick Start (New Machine Setup)

### Prerequisites
| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | 18+ | `node --version` |
| Docker Desktop | Latest | `docker --version` |
| npm | 9+ | `npm --version` |

### Step 1: Install Dependencies
```powershell
# Backend
cd whatsapp-message-pipeline
npm install

# Dashboard
cd dashboard
npm install
cd ..
```

### Step 2: Configure Environment
Copy the example environment file and edit it:
```powershell
copy .env.example .env
```

**Edit `.env` with your values** (see Configuration section below).

### Step 3: Start Kafka (Docker)
```powershell
docker-compose up -d
```
Wait ~30 seconds for Kafka to be healthy. Verify at http://localhost:8080

### Step 4: Start Backend
```powershell
npm start
```
📱 **Scan the QR code** displayed in terminal with WhatsApp → Settings → Linked Devices

### Step 5: Start Dashboard (new terminal)
```powershell
cd dashboard
npm run dev
```
Open http://localhost:5173

---

## ⚙️ Configuration

### Required Configuration (`.env`)

```env
# =========================================
# REQUIRED - Must configure before running
# =========================================

# Groq API Key (FREE) - Get from https://console.groq.com/keys
GROQ_API_KEY=gsk_your_api_key_here
```

### Optional Configuration (`.env`)

```env
# =========================================
# MESSAGE PROCESSING BEHAVIOR
# =========================================

# How long to wait for more messages before processing (seconds)
# Lower = faster response, Higher = better multi-message grouping
MESSAGE_CORRELATION_TIMEOUT_SECONDS=120

# Max messages to collect before forcing processing
MAX_MESSAGES_PER_SESSION=10

# Filter to only process messages from specific sender (leave empty for all)
# Format: phone@s.whatsapp.net (e.g., 919876543210@s.whatsapp.net)
WHATSAPP_ALLOWED_SENDER=

# =========================================
# SESSION PERSISTENCE
# =========================================

# Hours to keep WhatsApp session alive (default 15 hours)
WHATSAPP_SESSION_HOURS=15

# =========================================
# SERVER PORTS
# =========================================

# API server port
API_PORT=3000

# WebSocket port for real-time updates
WEBSOCKET_PORT=3001

# =========================================
# KAFKA CONFIGURATION
# =========================================

# Kafka broker address (change if Kafka is on different host)
KAFKA_BROKERS=localhost:9092

# Kafka client identifier
KAFKA_CLIENT_ID=whatsapp-pipeline

# Consumer group ID
KAFKA_GROUP_ID=message-processors

# =========================================
# DATABASE
# =========================================

# SQLite database file path
DATABASE_PATH=./data/messages.db

# =========================================
# LOGGING
# =========================================

# Log level: error, warn, info, debug
LOG_LEVEL=info
```

---

## 🔧 Common Configuration Changes

### Change Message Wait Time
To process messages faster (30 seconds instead of 2 minutes):
```env
MESSAGE_CORRELATION_TIMEOUT_SECONDS=30
```

### Only Process Messages from One Person
```env
WHATSAPP_ALLOWED_SENDER=919876543210@s.whatsapp.net
```

### Change Ports
```env
API_PORT=4000
WEBSOCKET_PORT=4001
```
Also update `dashboard/vite.config.js` if changing API_PORT.

### Use Different Kafka Server
```env
KAFKA_BROKERS=192.168.1.100:9092
```

---

## 📁 Project Structure

```
whatsapp-message-pipeline/
├── .env                 # Your configuration (create from .env.example)
├── .env.example         # Example configuration template
├── docker-compose.yml   # Kafka Docker setup
├── package.json         # Backend dependencies
├── src/
│   ├── index.js         # Main entry point
│   ├── config/          # Configuration loader
│   ├── whatsapp/        # WhatsApp connection (Baileys)
│   ├── correlation/     # Multi-message grouping
│   ├── llm/             # Groq LLM integration
│   ├── kafka/           # Kafka producer/consumer
│   ├── database/        # SQLite storage
│   ├── api/             # REST API & WebSocket
│   └── utils/           # Logger utilities
├── dashboard/           # React dashboard
│   ├── src/App.jsx      # Main React component
│   └── vite.config.js   # Vite config (API proxy)
├── data/                # SQLite database (auto-created)
├── sessions/            # WhatsApp session data
└── logs/                # Application logs
```

---

## 🛑 Stopping the Application

```powershell
# Stop backend (Ctrl+C in terminal)

# Stop Kafka
docker-compose down

# Stop Kafka and delete data
docker-compose down -v
```

---

## 🗑️ Reset Everything

```powershell
# Delete database (removes all contacts)
del data\messages.db

# Delete WhatsApp session (will need to scan QR again)
rmdir /s sessions

# Delete Kafka data
docker-compose down -v
```

---

## 🔍 Troubleshooting

| Problem | Solution |
|---------|----------|
| QR code not appearing | Delete `sessions` folder and restart |
| "EADDRINUSE" error | Another process using the port. Kill it or change ports in `.env` |
| Kafka connection failed | Ensure Docker is running: `docker-compose up -d` |
| LLM extraction empty | Check GROQ_API_KEY is valid in `.env` |
| Dashboard not loading | Check API is running on port 3000 |

---

## 📊 Useful URLs

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:5173 |
| API Health | http://localhost:3000/health |
| Kafka UI | http://localhost:8080 |

---

## 🔐 Getting a Groq API Key (Free)

1. Go to https://console.groq.com
2. Sign up with Google/GitHub
3. Click "API Keys" → "Create API Key"
4. Copy the key starting with `gsk_`
5. Paste in your `.env` file

---

## 📦 Moving to Another Machine

1. Copy the entire `whatsapp-message-pipeline` folder
2. Run `npm install` in both root and `dashboard` folders
3. Create `.env` file with your GROQ_API_KEY
4. Start Docker, then follow Quick Start steps
5. Scan new QR code (sessions are device-specific)
