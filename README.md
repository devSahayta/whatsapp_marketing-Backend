# WhatsApp Marketing Backend

A feature-rich WhatsApp Business API marketing and messaging platform backend built with Node.js and Express. It enables users to create and manage WhatsApp campaigns, handle bulk messaging, track analytics, manage contact groups, and process payments — all powered by the Meta WhatsApp Business API.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Overview](#api-overview)
- [Database Schema](#database-schema)

---

## Features

- **Campaign Management** — Create, schedule, and track WhatsApp marketing campaigns with template support
- **WhatsApp Integration** — Webhook receiver for incoming messages, delivery status tracking, and template synchronization with Meta
- **Group & Contact Management** — Create contact groups with bulk CSV import
- **Analytics & Reporting** — Message delivery stats, daily volume charts, and date-range filtering
- **Payment & Subscription** — Razorpay integration for plan purchases with signature verification
- **AI Features** — Claude (Anthropic) integration for intelligent message processing; ElevenLabs knowledge base creation
- **Account Warmup** — Automated warmup workflows based on WhatsApp messaging tier
- **Authentication** — Kinde OAuth with JWT verification via JWKS

---

## Tech Stack

| Category | Technology |
|---|---|
| Runtime & Framework | Node.js (ES Modules), Express.js v5 |
| Database | Supabase (PostgreSQL) |
| WhatsApp API | Meta Graph API v25.0 |
| Authentication | Kinde (JWT / OAuth) |
| Payments | Razorpay |
| AI / ML | Anthropic Claude API, Groq SDK, ElevenLabs |
| File Processing | Multer, pdf-lib, pdf2pic, Google Cloud Vision |
| Scheduling | node-cron |
| Utilities | Axios, node-fetch, jose, Canvas, @fast-csv/parse |

---

## Project Structure

```
whatsapp_marketing-Backend/
│
├── app.js                              # Express app entry point & route mounting
├── package.json                        # Project metadata & dependencies
├── .env                                # Environment variables (not committed)
├── .gitignore
├── test-kb-fetch.js                    # Knowledge Base system test
│
├── config/
│   └── supabase.js                     # Supabase client initialization
│
├── middleware/
│   ├── authMiddleware.js               # Auth enforcement on protected routes
│   └── extractKindeUser.js             # JWT extraction & user parsing from Kinde
│
├── models/
│   ├── userModel.js                    # User CRUD operations
│   ├── conversationModel.js            # Conversation / event tracking
│   └── groupModel.js                   # Group & contact management
│
├── controllers/
│   ├── campaignController.js           # Campaign creation, scheduling & management
│   ├── whatsappController.js           # WhatsApp webhook & incoming message handling
│   ├── whatsappTemplateController.js   # Template CRUD & Meta sync
│   ├── paymentController.js            # Razorpay order creation & verification
│   ├── analyticsController.js          # Message stats & chart data
│   ├── knowledgeBaseController.js      # Knowledge base creation (ElevenLabs)
│   ├── creditController.js             # User credit balance management
│   ├── groupController.js              # Contact group management
│   ├── mediaController.js              # Media upload & retrieval
│   ├── uploadController.js             # File upload handling
│   ├── userController.js               # User profile management
│   ├── chatController.js               # Chat session management
│   ├── waccountController.js           # WhatsApp account setup & configuration
│   ├── adminChatController.js          # Admin-level chat management
│   ├── WarmupController.js             # Account warmup orchestration
│   └── agentController.js              # AI agent operations
│
├── routes/
│   ├── campaignRoutes.js               # /api/campaigns/*
│   ├── whatsappRoutes.js               # / (webhook) & related endpoints
│   ├── whatsappTemplateRoutes.js       # /api/watemplates/*
│   ├── paymentRoutes.js                # /api/payment/*
│   ├── analyticsRoutes.js              # /api/analytics/*
│   ├── knowledgeBaseRoutes.js          # /api/knowledge-bases/*
│   ├── groupRoutes.js                  # /api/groups/*
│   ├── creditRoutes.js                 # /api/credits/*
│   ├── mediaRoutes.js                  # /api/media/*
│   ├── uploadRoutes.js                 # /api/upload/*
│   ├── userRoutes.js                   # /api/users/*
│   ├── chatRoutes.js                   # /api/chats/*
│   ├── waccountRoutes.js               # /api/waccount/*
│   ├── warmup.js                       # /api/warmup/*
│   ├── adminChatRoutes.js              # /admin/*
│   └── agentRoutes.js                  # /api/agents/*
│
├── services/
│   ├── metaWhatsApp.js                 # Meta Graph API wrapper (send/manage messages)
│   ├── waAccountService.js             # WhatsApp account operations
│   ├── whatsappTemplateService.js      # Template synchronization logic
│   ├── subscriptionService.js          # Subscription plan management
│   └── flightStatus.js                 # Flight status API integration
│
└── utils/
    ├── claudeClient.js                 # Anthropic Claude API wrapper with retry logic
    ├── whatsappClient.js               # WhatsApp message client
    ├── whatsappMedia.js                # Media download & processing
    ├── whatsappSender.js               # Core WhatsApp message sender
    ├── whatsappTemplateHelpers.js      # Template variable formatting helpers
    ├── elevenlabsApi.js                # ElevenLabs API wrapper
    ├── messageFormatter.js             # Message formatting utilities
    ├── pdfExtractor.js                 # PDF to text extraction
    ├── aiDecisionEngine.js             # AI-based message routing logic
    ├── autoExtractor.js                # Automatic content extraction
    ├── warmupHelper.js                 # Warmup configuration & tier helpers
    └── weddingInfo.js                  # Wedding event info retrieval
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- A [Supabase](https://supabase.com) project
- Meta WhatsApp Business API access
- [Kinde](https://kinde.com) account for authentication
- Razorpay account for payments

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd whatsapp_marketing-Backend

# Install dependencies
npm install

# Copy environment template and fill in values
cp .env.example .env
```

### Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

The server starts on the port defined in `.env` (default: `5000`).

---

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Server
PORT=5000

# Supabase
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_BUCKET=your_storage_bucket_name

# WhatsApp / Meta
WHATSAPP_VERIFY_TOKEN=your_webhook_verify_token
WHATSAPP_TOKEN=your_meta_whatsapp_api_token
WHATSAPP_PHONE_ID=your_whatsapp_phone_number_id

# Authentication (Kinde)
KINDE_DOMAIN=https://your-domain.kinde.com

# Payments (Razorpay)
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret

# AI Services
ANTHROPIC_API_KEY=your_anthropic_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key

# Misc
TEMPLATE_BASE_URL=your_template_service_url
```

---

## API Overview

| Base Path | Description |
|---|---|
| `POST /` | WhatsApp webhook receiver (incoming messages & delivery status) |
| `GET /` | WhatsApp webhook verification |
| `/api/campaigns` | Campaign CRUD — create, list, update, cancel, retry |
| `/api/watemplates` | WhatsApp template management & Meta sync |
| `/api/groups` | Contact group creation and management |
| `/api/analytics` | Message statistics and delivery charts |
| `/api/payment` | Razorpay order creation and payment verification |
| `/api/credits` | User credit balance read/write |
| `/api/knowledge-bases` | AI knowledge base management (ElevenLabs) |
| `/api/media` | Media file upload and retrieval |
| `/api/users` | User profile management |
| `/api/waccount` | WhatsApp Business account setup |
| `/api/warmup` | Account warmup status and configuration |
| `/admin` | Admin-level chat management |

---

## Database Schema

Key tables in the Supabase PostgreSQL database:

| Table | Description |
|---|---|
| `users` | User accounts and credit balances |
| `groups` | Contact groups per user |
| `group_contacts` | Individual contacts within groups |
| `chats` | Chat sessions (group_id + phone_number) |
| `whatsapp_accounts` | WhatsApp Business Account credentials |
| `whatsapp_templates` | Message templates with variable definitions |
| `whatsapp_messages` | Sent messages with delivery status tracking |
| `campaign_messages` | Per-recipient message records for campaigns |
| `campaigns` | Campaign metadata, scheduling, and status |
| `knowledge_bases` | AI knowledge bases (ElevenLabs integration) |
| `plans` | Available subscription plans |
| `payments` | Payment transaction records |

---

## License

Private — All rights reserved. &copy; Samvaadik