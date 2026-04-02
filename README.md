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
supabase/migrations/004_mailbox_warmup.sql
supabase/migrations/005_email_verifications.sql
supabase/migrations/006_org_management.sql
supabase/migrations/007_simplify_org.sql
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
| `AWS_ACCESS_KEY_ID` | Worker only | AWS IAM key — create an IAM user with `AmazonSESFullAccess` |
| `AWS_SECRET_ACCESS_KEY` | Worker only | AWS IAM secret — shown once at creation |
| `AWS_REGION` | Worker only | SES region, e.g. `eu-west-1` |
| `SES_FROM_EMAIL` | Worker only | Verified sender email in AWS SES |
| `SES_WEBHOOK_SECRET` | Worker only | Random string to protect the bounce webhook URL |
| `IMAP_ENCRYPTION_KEY` | Worker only | 64 hex characters (32 random bytes) |
| `FRONTEND_URL` | Always | Base URL of the frontend app (for invitation emails), e.g. `http://localhost:3001` |
| `PORT` | Optional | Defaults to `3000` |

Generate the encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate the webhook secret:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## API Endpoints

Full interactive docs at `/api/docs`. Summary:

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create a new company + admin user |
| `POST` | `/api/auth/login` | Sign in, returns `access_token` and `refresh_token` |
| `POST` | `/api/auth/refresh` | Exchange a `refresh_token` for a new `access_token` |

### Company
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/company` | Get company profile |
| `PATCH` | `/api/company` | Update company profile |
| `GET` | `/api/company/users` | List team members |

### Organization Management
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/org/invitations` | List pending invitations |
| `POST` | `/api/org/invitations` | Send an invitation email |
| `DELETE` | `/api/org/invitations/:id` | Revoke a pending invitation |
| `GET` | `/api/org/invitations/check?token=` | Check invitation validity (public) |
| `POST` | `/api/org/accept-invite/register` | Accept invitation and register |
| `DELETE` | `/api/org/members/:id` | Remove a team member |

### Mailboxes
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mailboxes` | List mailboxes (IMAP config omitted) |
| `POST` | `/api/mailboxes` | Add a mailbox (IMAP config encrypted at rest) |
| `DELETE` | `/api/mailboxes/:id` | Remove a mailbox |

### Target Groups
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/target-groups` | List target groups |
| `POST` | `/api/target-groups` | Create a target group |
| `DELETE` | `/api/target-groups/:id` | Delete a target group (fails if linked to a campaign) |

### Leads
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/leads` | List leads (`?target_group_id=`, `?page=`, `?limit=`) |
| `PATCH` | `/api/leads/:id` | Update lead status or notes |
| `POST` | `/api/leads/preview` | Parse an Excel file and return its column headers |
| `POST` | `/api/leads/import` | Import leads from `.xlsx` file |

### Sequences
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sequences` | List all sequences with steps |
| `POST` | `/api/sequences` | Create a sequence |
| `GET` | `/api/sequences/:id` | Get a single sequence with steps |
| `DELETE` | `/api/sequences/:id` | Delete a sequence and all its steps |
| `POST` | `/api/sequences/:id/steps` | Add a step |
| `PATCH` | `/api/sequences/:id/steps/:stepId` | Edit a step |
| `DELETE` | `/api/sequences/:id/steps/:stepId` | Delete a step |

### Campaigns
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/campaigns` | List campaigns |
| `POST` | `/api/campaigns` | Create campaign and start sending |
| `GET` | `/api/campaigns/:id` | Get a single campaign |
| `PATCH` | `/api/campaigns/:id` | Update status (`active`, `paused`, `completed`) or name |
| `GET` | `/api/campaigns/:id/stats` | Get stats (sent / pending / replied + breakdown) |

### Webhooks
| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/ses?token=SECRET` | Receives SES bounce and complaint notifications from SNS |

---

## How the Worker Works

### Email Sender
Listens to the BullMQ `email-sending` queue. When `POST /api/campaigns` is called, jobs are created per lead with scheduled delays. For each job the worker:

1. Checks if the mailbox is paused — skips if true
2. Checks today's send count against the daily limit — requeues for tomorrow if exceeded
3. Checks if the lead is still `active` — skips if `replied`, `unsubscribed`, etc.
4. Merges `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{full_name}}` into the subject and body
5. Sends the email via AWS SES
6. Writes a row to `email_logs` with status `sent`
7. If there is a next sequence step, schedules it at a random time within working hours on the target day

### Reply Catcher
Polls every 5 minutes. For each mailbox:

1. Connects via IMAP and reads unseen emails from the last 24 hours
2. Matches the sender email against leads that were previously contacted
3. Categorizes the reply body using keyword matching (supports English and Bulgarian):
   - **Positive:** interest, yes, sure, schedule, when, интересувам се, да, добре, etc.
   - **Negative:** not interested, no thanks, remove, не ме интересува, не благодаря, etc.
   - **Out of office:** vacation, out of office, отсъствам, ваканция, etc.
   - **Neutral:** fallback if no keywords match
4. Updates `email_logs` with the category
5. Sets the lead status to `replied` — which stops all future emails to that lead

---

## Email Warmup & Deliverability

To avoid the spam folder, emails are sent within a working window (09:00–17:00 UTC) with random 3–8 minute gaps between sends. Daily limits ramp up automatically per inbox:

| Days since mailbox created | Daily limit |
|---|---|
| 0–6 | 8 emails/day |
| 7–20 | 12 emails/day |
| 21+ | 18 emails/day |
| Hard cap (v1) | 25 emails/day |

If a mailbox's hard bounce rate exceeds **5%** over the last 30 days, it is automatically paused and no further emails are sent from it. Bounces are detected via the SES webhook.

### SES Webhook Setup (AWS)
1. SNS → **Create topic** (Standard) → note the ARN
2. SES → your verified identity → **Notifications** → assign the SNS topic for **Bounces** and **Complaints**
3. Add `SES_WEBHOOK_SECRET` to your `.env`
4. SNS → **Subscriptions** → HTTPS → URL: `https://your-api.com/webhooks/ses?token=YOUR_SECRET`
5. The first request is a `SubscriptionConfirmation` — the handler auto-confirms it

---

## Lead Import Format

Upload an `.xlsx` file to `POST /api/leads/import`. Use `POST /api/leads/preview` first to see the column headers, then pass a `column_map` if headers are non-standard.

Auto-detected column names (case-insensitive):

| Field | Recognized headers |
|---|---|
| `email` | `email`, `e-mail`, `email address` |
| `first_name` | `first_name`, `first name`, `firstname`, `name` |
| `last_name` | `last_name`, `last name`, `lastname`, `surname` |
| `notes` | `notes`, `note`, `comments`, `comment` |

For non-standard headers:
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
| `004_mailbox_warmup.sql` | Adds `warmup_started_at` and `is_paused` to mailboxes |
| `005_email_verifications.sql` | Adds `is_verified` and `verification_code` for email verification |
| `006_org_management.sql` | Creates `invitations` table for invite-only team management |
| `007_simplify_org.sql` | Removes `join_requests` and `audit_logs` (simplified org model) |

RLS is enforced on all tables using `public.get_auth_company_id()` — a `SECURITY DEFINER` function that prevents infinite recursion when querying the `users` table from within a policy.

---

## Organization Management

The platform uses an **invite** model:

- All team members have **owner-level** access (no role hierarchy)
- New members join by accepting email invitations
- Invitations expire after 24 hours
- When accepting an invitation, users register directly (no need for existing account)
- Members can be removed by any team member

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

Both containers need the same `.env` values. The worker additionally requires the AWS keys, `SES_WEBHOOK_SECRET`, and `IMAP_ENCRYPTION_KEY`.
