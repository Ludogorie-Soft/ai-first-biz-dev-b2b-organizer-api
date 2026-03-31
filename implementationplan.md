## 📌 Context (IMPORTANT)

You are currently working in the Backend/API (-api) repository. Please focus your code generation on the NodeJS, Express, BullMQ workers, and Supabase database logic defined in this plan.

# **B2B Outreach Platform — Implementation Plan v1 (MVP)**

## **Overview**

A multi-tenant SaaS platform (v1 MVP) for B2B email outreach. The core focus is on creating target groups, building simple email sequences, reliably sending emails via AWS SES, and automatically catching/categorizing replies to stop sequences.

- **Architecture:** Multi-repo (Separate Frontend and API/Worker repositories).

---

## **1\. System Architecture & Tech Stack**

### **Repository 1: Frontend (\-fe)**

- **Framework:** Next.js 15 (App Router)
- **UI/Styling:** Tailwind CSS \+ Shadcn/UI
- **State Management:** Zustand (Global) \+ TanStack Query (Data fetching)
- **Forms & Validation:** React Hook Form \+ Zod
- **Deployment:** Vercel (Serverless, auto-scaling)

### **Repository 2: API & Worker (\-api)**

- **Framework (API):** NodeJS \+ Express
- **Queue System:** BullMQ \+ Redis (Upstash Serverless Redis)
- **Background Environment:** Long-running Node.js worker process residing in this repository.
- **Email Transport:** AWS SES (Amazon Simple Email Service) for highly reliable outbound sending.
- **Reply Catcher:** Basic IMAP integration to read inboxes and categorize replies.
- **Deployment:** Render, Railway, or Fly.io (Requires a long-running environment for the worker).

### **Shared Services**

- **BaaS:** Supabase (PostgreSQL, Auth, Storage, Realtime)
- **Multi-tenancy:** Row Level Security (RLS) policies per company_id
- **Type Synchronization:** Supabase CLI (supabase gen types typescript) used in both repositories.

---

### **2\. Database Schema (Key Entities)**

_All tables are secured via RLS using company_id._

| Table              | Key Fields                                                                                                                                            | Purpose                                                                                                               |
| :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| companies          | id, name, website, industry, description, created_at                                                                                                  | Top-level tenant entity (provides context for future AI).                                                             |
| users              | id, company_id, role, email                                                                                                                           | Platform users mapping to Supabase Auth.                                                                              |
| mailboxes          | id, company_id, email, imap_config (encrypted)                                                                                                        | Stores sender accounts and their IMAP connection info for replies.                                                    |
| target_groups      | id, company_id, name, description                                                                                                                     | Folders/Lists for organizing leads (e.g., "Online Stores BG").                                                        |
| leads              | id, company_id, target_group_id, email, first_name, last_name, status, notes (бележки за вътрешно ползване, които може да си сложим за даден контакт) | Contact details of prospects linked to a specific Target Group.                                                       |
| sequences          | id, company_id, name                                                                                                                                  | Container for email steps. _(Removed email_title/body from here)._                                                    |
| sequence_steps     | id, sequence_id, step_order, subject, body, delay_days                                                                                                | The ordered steps of a sequence. _(In v1.1, subject and body will act as AI prompt templates)._                       |
| campaigns          | id, company_id, target_group_id, status, description                                                                                                  | The main engine that links a target group to the execution logic.                                                     |
| campaign_sequences | campaign_id, sequence_id                                                                                                                              | Junction table. Links a campaign to one or multiple sequences (Prepares the system for A/B testing in v1.1).          |
| email_logs         | id, campaign_id, sequence_id, step_id, lead_id, mailbox_id, status, reply_category, sent_subject, sent_body                                           | Tracks execution. Logs exactly which sequence/step was used and stores the actual personalized text sent to the lead. |

---

## **3\. Phase 1 — Foundation & Setup**

- **Project Setup & Auth:** \* Initialize the \-fe repo (Next.js) and \-api repo.
  - Implement email/password auth via Supabase.
  - Strictly enforce RLS policies for company_id isolation.
- **Company & Team Management:**
  - **Company Profile:** UI in \-fe to enter company details (name, website, industry). API to store it.
  - **Team Management:** UI to invite new users and list all team members within the company.
- **Mailbox Management:** \* UI to add multiple email accounts for the company.
  - Securely save IMAP credentials (for the Reply Catcher) using Supabase Vault.
- **Target Groups & Lead Import:** \* UI to create "Target Groups".
  - Upload Excel via Supabase Storage, parsed in the \-api repo.
  - UI for column mapping, saving contacts directly into the selected Target Group.

---

## **4\. Phase 2 — Core Engine (Sequences & Campaigns)**

- **Sequence Builder:** \* Step-by-step timeline editor in the \-fe.
  - The user writes "Email 1", adds a rule like "Wait 3 days if no reply", and writes "Email 2".
  - Endpoints to save these ordered steps (subject, body, delay_days).
- **Create Campaign:** \* UI to name the campaign, select a Target Group, pick a Sequence, and choose sender Mailboxes.
  - _Note: Multiple campaigns can reuse the same Target Group._
- **Job Queue (BullMQ \+ Redis):** \* When a campaign starts, the backend queues tasks for each lead (e.g., "Send Step 1 now").
  - Automatically schedules future steps (e.g., "Send Step 2 in 3 days") upon successful send of Step 1\.
- **Simple Dashboard:** \* A basic table showing the campaign status.
  - Displays metrics: Emails Sent, Pending, and Replied (categorized).

---

## **5\. Phase 3 — Sending & Reply Catching (The Worker)**

- **Email Sender (AWS SES):** \* A background worker process that takes a scheduled task from the BullMQ queue.
  - Constructs the email (merging variables like {{first\_name}}) and sends it reliably via AWS SES API.
- **Reply Catcher & Categorizer (Basic IMAP):** \* A hidden cron/worker process that periodically logs into the connected IMAP mailboxes.
  - Matches incoming emails to outgoing threads.
  - **Action:** If a lead replies, it halts the sequence (removes future steps from the queue).
  - **Categorization:** Reads the reply body and uses simple keyword matching (or basic logic) to categorize the response as "Positive Reply", "Negative Reply/No Interest", etc., saving this to email_logs.

---

## **6\. API Design (Endpoints Overview)**

API documented automatically via Swagger (/api/docs) hosted in the \-api repo.

- **Company & Auth:** POST /auth/login, GET /company, PATCH /company, GET /company/users
- **Mailboxes:** GET /mailboxes, POST /mailboxes, DELETE /mailboxes/:id
- **Target Groups:** GET /target-groups, POST /target-groups
- **Leads:** POST /leads/import (assigned to Target Group), GET /leads
- **Sequences:** GET /sequences, POST /sequences, POST /sequences/:id/steps
- **Campaigns:** GET /campaigns, POST /campaigns (starts the queue logic)
- **Dashboard:** GET /campaigns/:id/stats (Returns sent, pending, and reply categories)

---

## **7\. Testing Strategy**

- **Unit Tests (Vitest):**
  - \-api repo: Delay calculations, sequence timeline mapping, reply categorization logic (e.g., ensuring "Stop bothering me" maps to Negative).
  - \-fe repo: Component rendering, sequence builder state updates.
- **Integration Tests:**
  - Full flow: Lead import → Create Campaign → Job queued → Task processed by worker.
  - Reply Detection Flow: Mock an IMAP reply, ensure the worker detects it, updates the lead status to "Replied", categorizes it, and cancels pending jobs in BullMQ.

---

## **8\. Infrastructure & Deployment Setup**

### **Environment 1: Frontend (\-fe repo)**

- **Platform:** AWS via Docker (e.g., Amazon ECS with AWS Fargate or EC2).
- **Build Strategy:** Next.js configured with \`output: 'standalone'\` for optimized, lightweight container images.
- **Env Vars:** NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL.

### **Environment 2: API & Worker (\-api repo)**

- **Platform:** AWS via Docker (e.g., Amazon ECS with AWS Fargate or EC2). Deployed as a long-running container to sustain the Express server, BullMQ workers, and IMAP polling.
- **Env Vars:** \* SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL
  - IMAP_ENCRYPTION_KEY (For Supabase Vault)
  - AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (For AWS SES)

### **Global Infrastructure**

- **Database & Auth:** Supabase Cloud.
- **Container Registry:** Amazon ECR (Elastic Container Registry) to store Docker images.
- **Queue:** Upstash Redis (Serverless Redis).

---

Links:  
[Sample Excel](https://docs.google.com/spreadsheets/d/13XFiZipQrq_Nz_3P7XjYf-cANI-f8GykfTNWbDVCi9E/edit?usp=sharing) \- sample leads table  
[Sample email sequence](https://docs.google.com/document/d/1Porxy3Mpr_rmZGCO8PNz0RmMYDDjfEqUvnVz2N6ao-Y/edit?usp=sharing) \- sample email sequence  
[details how to achieve it](https://docs.google.com/document/d/1S0yRq3F7KxVxXc6_9SlGShVdkAu7_Kp8w6l5VTnfEHo/edit?tab=t.0) \- prevent emails from being marked as spam
