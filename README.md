# Privacy-First Local AI Email Classifier

A high-performance TypeScript service that automatically classifies and labels your Gmail inbox using local or remote open-source LLMs (via Ollama) and a sequential two-stage agent architecture.

Zero email content ever leaves your infrastructure.

---

## Features

- **Strict Privacy**: All email parsing and LLM inference runs locally on your machine or private LAN server.
- **Node 24 Alpine Dockerized with Native Cron**: Containerized with Alpine's native `crond` scheduler—Node completely unloads from RAM between runs, reducing container idle memory to **~1.5 MB**.
- **Sequential Two-Stage Agent Pipeline**:
  - **Agent 1 (Attachment Summarizer)**: In-memory PDF text extraction and structured compression (Document Type, Key Entities, Totals, Dates, Action Items).
  - **Agent 2 (Email Classifier)**: Whole conversation thread context + attachment summaries classified against live Gmail user labels with strict JSON Schema constraints.
- **Self-Improving Learned Rules**: Local caching of classification heuristics (`learned_rules.json`) that adapt over time.
- **Unmatched Email Logging for Category Planning**: Automatically tracks emails that do not match existing labels into `unmatched.json` with metadata, enabling future label discovery and category planning.
- **Dynamic Gmail Label Discovery**: Auto-discovers labels and synchronizes configured hints.
- **Automatic Memory Culling**: Configurable `keepAlive` (e.g. `15s`) automatically unloads the model from RAM down to 0 MB when idling between poll cycles.

---

## Security & Privacy by Design

This project is built from the ground up for strict local privacy:

- **Git-Ignored Personal Data**: All runtime configuration (`config.json`), authentication tokens (`credentials.json`, `token.json`, `.env`), learned rules (`learned_rules.json`), classification logs (`unmatched.json`, `history.csv`), and log files are excluded from source control.
- **Template-Based Setup**: Always use `config.example.json` and `.env.example` as blueprints; never commit active credentials or personal label rules.

---

## Quickstart with Docker Compose

### 1. Configure Environment and Credentials

Copy template configuration files:

```bash
cp .env.example .env
cp config.example.json config.json
```

Place your Google Cloud OAuth 2.0 Desktop credentials in the project root:
```bash
# Place your downloaded OAuth client secrets here
cp /path/to/downloaded-oauth-credentials.json credentials.json
```

Edit `.env`:
```bash
# Connect to Ollama on host machine, remote LAN IP, or custom server:
OLLAMA_HOST=http://host.docker.internal:11434
OLLAMA_MODEL=phi4-mini

# Cron schedule (default: every 5 minutes)
CRON_SCHEDULE="*/5 * * * *"
```

### 2. Start the Background Service
```bash
docker compose up -d
```
*The container will run an immediate pass on startup, then idle at ~1.5 MB RAM until the next scheduled cron tick.*

### 3. View Live Logs & Progress
```bash
docker compose logs -f
```

### 4. Run a One-Off Pass / Dry-Run
```bash
# Single dry-run preview:
docker compose run --rm email-classifier --once --dry-run --limit 20

# Single live pass:
docker compose run --rm email-classifier --once --limit 50
```

---

## Local Development & Native CLI

### Prerequisites
- **Node.js 24+**
- **Ollama** running locally on `http://127.0.0.1:11434` (`ollama pull phi4-mini` or `ollama pull qwen2.5:7b`)
- **`credentials.json`** (Google Cloud OAuth 2.0 Desktop Client ID)

### Setup
```bash
npm install
cp config.example.json config.json
cp .env.example .env
npm run build
```

### Commands
```bash
# Dry-run preview
npm start -- --once --dry-run --limit 20

# Live single pass
npm start -- --once --limit 100

# Continuous background daemon
npm start -- --daemon --interval 300
```

---

## Configuration Reference (`config.example.json`)

```json
{
  "ollama": {
    "host": "http://127.0.0.1:11434",
    "model": "phi4-mini",
    "contextWindow": 32768,
    "temperature": 0.0,
    "keepAlive": "15s"
  },
  "gmail": {
    "credentialsPath": "credentials.json",
    "tokenPath": "token.json",
    "searchQuery": "has:nouserlabels in:inbox",
    "fallbackLabelName": "Other",
    "batchSize": 10
  },
  "classification": {
    "minConfidenceThreshold": 0.7,
    "escalationThreshold": 0.95,
    "learnedRulesPath": "learned_rules.json",
    "unmatchedPath": "unmatched.json",
    "historyPath": "history.csv",
    "labelHints": {
      "Bills": "Utility bills, invoices, bank statements, payment confirmations, and recurring charges.",
      "Security": "One-time passcodes (OTP), 2FA verification codes, login alerts, and account security changes.",
      "Order": "Purchase receipts, order tracking, shipping dispatch notifications, and return postage labels.",
      "Advertisement": "Marketing flyers, newsletters, discount codes, and promotional offers."
    }
  }
}
```

