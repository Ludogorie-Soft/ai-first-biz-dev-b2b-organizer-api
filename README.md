# B2B Organizer — API

Backend API and worker for the B2B email outreach platform. Built with Node.js, Express, BullMQ, and Supabase.

---

## Architecture

The backend runs as **two separate processes**:

| Process | Command | Role |
|---|---|---|
| API Server | `npm run dev` | Handles all HTTP requests |
| Worker | *(started automatically with `npm run dev`)* | Sends emails via SES + catches replies via IMAP |

Both processes start together when you run `npm run dev` (via `concurrently`). In production, deploy them as two separate containers.

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express
- **Queue:** BullMQ + Upstash Redis
- **Database & Auth:** Supabase (PostgreSQL + Auth)
- **Email Sending:** AWS SES
- **Reply Catching:** IMAP (imapflow)
- **Validation:** Zod
- **API Docs:** Swagger UI (`/api/docs`)

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required values (see [Environment Variables](#environment-variables) below).

### 3. Run database migrations

Run these in order in the Supabase SQL editor:

```
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_campaign_mailboxes.sql
supabase/migrations/003_leads_unique.sql
```

### 4. Start development

```bash
npm run dev
```

API server: `http://localhost:3000`
Swagger docs: `http://localhost:3000/api/docs`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Always | Project URL from Supabase → Settings → Data API |
| `SUPABASE_SERVICE_ROLE_KEY` | Always | Service role key (bypasses RLS — keep secret) |
| `REDIS_URL` | Always | Upstash Redis URL starting with `rediss://` |
| `AWS_ACCESS_KEY_ID` | Worker only | AWS IAM key with SES permissions |
| `AWS_SECRET_ACCESS_KEY` | Worker only | AWS IAM secret |
| `AWS_REGION` | Worker only | e.g. `us-east-1` |
| `SES_FROM_EMAIL` | Worker only | Verified sender email in AWS SES |
| `IMAP_ENCRYPTION_KEY` | Worker only | 64 hex characters (32 random bytes) |
| `PORT` | Optional | Defaults to `3000` |

Generate the encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## API Endpoints

Full interactive docs at `/api/docs`. Summary:

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create a new company + admin user |
| `POST` | `/api/auth/login` | Sign in, returns `access_token` |

### Company
| Method | Path | Description | Role |
|---|---|---|---|
| `GET` | `/api/company` | Get company profile | Any |
| `PATCH` | `/api/company` | Update company profile | Owner / Admin |
| `GET` | `/api/company/users` | List team members | Any |

### Mailboxes
| Method | Path | Description | Role |
|---|---|---|---|
| `GET` | `/api/mailboxes` | List mailboxes | Any |
| `POST` | `/api/mailboxes` | Add a mailbox (IMAP config encrypted at rest) | Any |
| `DELETE` | `/api/mailboxes/:id` | Remove a mailbox | Owner / Admin |

### Target Groups
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/target-groups` | List target groups |
| `POST` | `/api/target-groups` | Create a target group |

### Leads
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/leads` | List leads (`?target_group_id=`, `?page=`, `?limit=`) |
| `POST` | `/api/leads/import` | Import leads from `.xlsx` file |

### Sequences
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sequences` | List sequences with steps |
| `POST` | `/api/sequences` | Create a sequence |
| `POST` | `/api/sequences/:id/steps` | Add a step to a sequence |

### Campaigns
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List campaigns |
| `POST` | `/api/campaigns` | Create campaign and start sending |
| `GET` | `/api/campaigns/:id/stats` | Get campaign stats (sent / pending / replied) |

---

## How the Worker Works

### Email Sender
Listens to the BullMQ `email-sending` queue. When `POST /api/campaigns` is called, one job is created per lead. For each job the worker:

1. Checks if the lead is still `active` — skips if `replied`, `unsubscribed`, etc.
2. Merges `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{full_name}}` into the subject and body
3. Sends the email via AWS SES
4. Writes a row to `email_logs` with status `sent`
5. If there is a next sequence step, schedules a delayed job (`delay_days × 24h`)

### Reply Catcher
Polls every 5 minutes. For each mailbox:

1. Connects via IMAP and reads unseen emails from the last 24 hours
2. Matches the sender email against leads that were previously contacted
3. Categorizes the reply body: `positive`, `negative`, `neutral`, or `out_of_office`
4. Updates `email_logs` with the category
5. Sets the lead status to `replied` — which stops all future emails to that lead

---

## Lead Import Format

Upload an `.xlsx` file to `POST /api/leads/import`. The endpoint auto-detects columns by header name. Recognized headers (case-insensitive):

| Field | Recognized column names |
|---|---|
| `email` | `email`, `e-mail`, `email address` |
| `first_name` | `first_name`, `first name`, `firstname`, `name` |
| `last_name` | `last_name`, `last name`, `lastname`, `surname` |
| `notes` | `notes`, `note`, `comments`, `comment` |

For non-standard headers, pass a `column_map` JSON string:
```json
{"email": "Work Email", "first_name": "Given Name", "last_name": "Family Name"}
```

---

## Database Migrations

| File | Description |
|---|---|
| `001_initial_schema.sql` | All core tables, enums, RLS policies, helper function |
| `002_campaign_mailboxes.sql` | Junction table linking campaigns to sender mailboxes |
| `003_leads_unique.sql` | Unique constraint on leads (required for import upsert) |

RLS is enforced on all tables using `public.get_auth_company_id()` — a `SECURITY DEFINER` function that prevents infinite recursion when querying the `users` table from within a policy.

---

## Production Deployment

Deploy as two separate Docker containers from the same image:

```dockerfile
# API container
CMD ["node", "dist/server.js"]

# Worker container
CMD ["node", "dist/worker.js"]
```

Build:
```bash
npm run build   # outputs to dist/
```

Both containers need the same `.env` values. The worker additionally needs the AWS and IMAP encryption keys.
