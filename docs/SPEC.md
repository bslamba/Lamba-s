# Claude Code Build Specification: Lamba Family Expense & Settlement Web Application

## Project Metadata & Environment Configuration

- **Target Agent**: Claude Code CLI
- **Repository / App Name**: `lambafamily`
- **Hosting & APIs**: Vercel (Project: `bhawneetlamba`, Team: `blamba`)
- **Domain**: `lambafamily.vercel.app`
- **Database**: Supabase Postgres 17 (Project: `lamba-family`, Region: `ap-south-1` Mumbai)
- **Object Storage**: S3-compatible bucket (Backblaze B2 or Supabase Storage; endpoint, region, access keys configured via Vercel environment variables)
- **Framework & Runtime**: Next.js 16 (App Router), React 19, TypeScript (strict mode), Tailwind CSS, Lucide Icons, Shadcn UI
- **Database Access Pattern**: Postgres via guarded database functions / server actions with strict Zod runtime validation and Row Level Security (RLS)

---

## 1. System Architecture & Security Specification

### 1.1 Authentication & Session Management
- **Password Storage**: Passwords must be hashed strictly using PBKDF2 with SHA-256 (minimum 100,000 iterations, 32-byte salt, 64-byte derived key). Plaintext passwords must never touch storage or logs.
- **Session Tokens**: Issue HMAC-signed HTTP-only, secure, `SameSite=Lax` session cookies.
- **Device Fingerprinting & 2FA Step-up**:
  - Hash client User-Agent and client IP prefix to verify device identity.
  - On new/unrecognized devices, require an email One-Time Password (6-digit OTP, valid for 10 minutes) sent to the user's verified email before minting the session cookie.
- **Rate Limiting**:
  - Integrate Upstash Redis via `@upstash/redis` and `@upstash/ratelimit`.
  - Rate limit sign-in attempts (max 5 attempts per 15 minutes per IP/email), OTP verification (max 3 attempts per code), and file uploads.
  - Provide an automated in-memory LRU fallback (`Map` with TTL) if Redis environment variables are missing or Redis connection fails.

### 1.2 Outbound & Inbound Email Infrastructure
- **Outbound Email (Nodemailer)**:
  - Transport priority: Use Resend API (`RESEND_API_KEY`) if configured; fallback to Gmail SMTP (`GMAIL_USER`, `GMAIL_APP_PASSWORD`).
  - Responsibilities: Sending sign-in/reset OTPs, daily bill reminders, and shared expense approval alerts.
- **Inbound Bank Email Webhook (`/api/vault/inbox/mail`)**:
  - Endpoint receives forwarded bank and UPI transaction alerts from a Google Apps Script running on Gmail every 5 minutes.
  - Authentication: Validated via an `x-vault-key` header matching a salted SHA-256 hash stored in the database per member.
  - Parsing Rules:
    - Only accept completed transactions.
    - Explicitly ignore: OTPs, promotional offers, payment requests/mandates, upcoming debit warnings, and failed/reversed transactions.
    - Extract: Transaction amount (in paise), merchant/payee, timestamp, reference number (UTR/RRN), bank identifier, and payment method (UPI, NetBanking, Card).
    - Store parsed records into an `inbox_messages` queue with status `pending`. No transaction is filed to ledger without explicit user confirmation.
- **Scheduled Cron Jobs**:
  - Vercel Cron triggers `GET /api/vault/reminders/run` daily at `03:30 UTC`.
  - Endpoint must verify `Authorization: Bearer ${CRON_SECRET}`.
  - Actions: Scan recurring fixed/fluctuating bills due within 3 days, detect pending approval requests older than 24 hours, and dispatch notification emails.

---

## 2. Domain Model & Business Entities

The application models exactly three expense entities:
1. **Gurneet** (User / Member)
2. **Bhawneet** (User / Admin)
3. **Common Family Account** (Household Pot / Shared Entity)

### Core Rules:
1. **Strict Expense Focus**: No personal income tracking (no salary, bank balances, investment tracking, or loan accounts). The only income allowed in the system is **Common Household Income** (e.g., rental income received into the shared pot) which exists solely to fund shared household spend.
2. **Entity Isolation**:
   - Expenses paid from the **Common Family Account** are already paid from shared funds. They must **never** be split into debts between Bhawneet and Gurneet.
   - Expenses paid by **Bhawneet** or **Gurneet** can be split between:
     - Bhawneet & Gurneet (bilateral shared expense)
     - Bhawneet, Gurneet & Common Account (three-way split)
     - Allocated 100% to the Common Account (member paid on behalf of the household, meaning the pot owes reimbursement to the payer).

---

## 3. Expense Management Engine

### 3.1 Currency Representation
- All monetary amounts must be stored as integers representing **whole paise** (`1 INR = 100 paise`).
- Zero floating-point arithmetic for balances, splits, or totals. Display conversions to ₹ format (`paise / 100`) occur strictly at the presentation layer.

### 3.2 Fixed vs. Fluctuating Expenses
The application maintains templates for recurring monthly obligations:
- **Fixed Expenses** (e.g., Broadband ₹1,499, Mobile Postpaid ₹999):
  - Configured with a default amount, billing day of month, payer, and split ratio.
  - Automatically posted to the active month's ledger upon month rollover or scheduled date.
  - Displayed in the "This Month" tab under a dedicated "Fixed Expenses" section with a "Live / Posted" status.
- **Fluctuating Expenses** (e.g., Grocery, Dairy / Milk delivery, Electricity Bill):
  - Configured with an estimated baseline amount and expected cycle.
  - Appear in the "This Month" tab under "Fluctuating Expenses" with status `Pending Actual`.
  - Feature an inline "Enter Actual" modal/action: user inputs the verified bill amount and submits. Upon submission, the expense hits the active month ledger and triggers approval/settlement calculation.

### 3.3 Expense Data Attributes
Every transaction record contains:
- `id`: UUID (v7 preferred or v4)
- `name` / `description`: string (e.g., "Tata Play Fiber")
- `amount_paise`: integer (> 0)
- `expense_date`: DATE (`YYYY-MM-DD`)
- `day_of_week`: computed / stored string (e.g., "Monday")
- `month_key`: string (`YYYY-MM`)
- `paid_by_entity`: enum (`BHAWNEET`, `GURNEET`, `COMMON_ACCOUNT`)
- `category` & `subcategory`: string (e.g., "Utilities" -> "Electricity")
- `tags`: text array (`string[]`)
- `receipt_url`: string (optional S3 / B2 presigned download URL)
- `envelope`: enum (`HOUSEHOLD`, `PERSONAL`, `GROUP`)
- `split_type`: enum (`EQUAL`, `EXACT_PAISE`, `PERCENTAGE`, `FULL_REIMBURSEMENT`)
- `splits`: JSONB array of `{ entity: string, share_paise: number }`
- `status`: enum (`DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `SETTLED`)

---

## 4. Settlement Engine & Mathematical Invariants

### 4.1 Whole Paise Remainder Distribution
When splitting an amount $A$ across $N$ entities:
- Base share: $S_{\text{base}} = \lfloor A / N \rfloor$
- Remainder paise: $R = A - (S_{\text{base}} \times N)$
- Distribute exactly 1 paise to the first $R$ participants (ordered deterministically: payer first, then alphabetical by entity name).
- **Invariant**: $\sum \text{shares} \equiv \text{total amount}$ down to the exact paise.

### 4.2 Bilateral Netting Algorithm (Bhawneet vs. Gurneet)
At any point in time or at month close:
1. **Direct Personal Debts**:
   - For every approved expense paid by Bhawneet where Gurneet has a share $s_G$: Gurneet owes Bhawneet $s_G$.
   - For every approved expense paid by Gurneet where Bhawneet has a share $s_B$: Bhawneet owes Gurneet $s_B$.
2. **Common Pot Isolation & Shortfall**:
   - Total Pot Spend $E_{\text{pot}}$ = sum of expenses paid by `COMMON_ACCOUNT` + sum of member expenses allocated to `COMMON_ACCOUNT`.
   - Net Pot Shortfall:
     $$\text{Shortfall} = \max\left(0, E_{\text{pot}} - I_{\text{common}} - S_{\text{carried\_in}}\right)$$
     where $I_{\text{common}}$ is common income declared for the month, and $S_{\text{carried\_in}}$ is surplus carried from previous closed month.
   - Earning members (Bhawneet & Gurneet) fund the shortfall equally ($50/50$ in whole paise).
   - If a member personally paid an expense allocated to the Common Account, the pot owes that member a reimbursement. If the pot has a shortfall, their reimbursement is credited against their shortfall contribution.
3. **Net Bilateral Balance**:
   $$\text{Net} = (\text{Gurneet's debt to Bhawneet}) - (\text{Bhawneet's debt to Gurneet})$$
   - If $\text{Net} > 0$: Gurneet owes Bhawneet $\text{Net}$.
   - If $\text{Net} < 0$: Bhawneet owes Gurneet $|\text{Net}|$.
   - If $\text{Net} = 0$: Settled.
4. **Month Close & Locking**:
   - Closing a month freezes a cryptographically immutable snapshot of transactions and calculations.
   - Carries forward any leftover pot surplus or unliquidated advance balance to the subsequent month.
   - Month edits are permanently locked once closed or once a settlement payment is recorded.

---

## 5. Approval & Workflow State Machine

1. **Immediate Execution**: Personal expenses and actions performed by Admin with zero impact on other members apply immediately without approval.
2. **Approval Triggers**:
   - Any transaction created or updated by Bhawneet that assigns a share $> 0$ to Gurneet requires Gurneet's approval.
   - Any transaction created or updated by Gurneet that assigns a share $> 0$ to Bhawneet requires Bhawneet's approval.
   - Modifications to Recurring Budgets or Common Income require agreement from both members.
3. **States**: `PENDING`, `ACCEPTED`, `RETURNED` (requires mandatory clarification comment), `DECLINED`, `REVOKED`.
4. **Concurrency & Re-check**: Approvals must use atomic transactions (`SELECT ... FOR UPDATE` or optimistic version locks) verifying the month is not locked/closed before committing state change.

---

## 6. Inbox & Email Parsing Triage

1. **Google Apps Script Contract**:
   - Forwards parsed emails to `/api/vault/inbox/mail` with JSON payload `{ sender, subject, date, bodyHtml, bodyText, messageId }`.
2. **Extraction Engine**:
   - Extracts amount, merchant/vendor name, transaction date/time, reference ID (UTR).
   - Deduplication: Uses SHA-256 hash of `(bank + reference_id + amount_paise)` to reject duplicate webhook calls.
3. **Filing Triage UI**:
   - Users review pending items in the Inbox.
   - Actions: "Convert to Expense" (pre-fills Add Expense form), "Match Due Recurring Bill" (marks fixed/fluctuating bill paid), or "Record Settlement Payment".

---

## 7. Frontend Specification & Application Tabs

- **Theme & UX**: Clean, modern financial interface with responsive desktop sidebar and mobile bottom navigation.
- **Tabs**:
  1. **Dashboard**:
     - Metric cards: Current Month Spend, Bhawneet Paid, Gurneet Paid, Common Account Paid, Current Net Settlement Owed/Owing (`Bhawneet owes Gurneet ₹X` or vice-versa).
     - Clicking any metric opens a modal or navigates to filtered transactions behind that exact figure.
  2. **This Month**:
     - Main operational ledger.
     - Section 1: Fixed Expenses (with status badges: "Auto-posted", "Paid").
     - Section 2: Fluctuating Expenses (with action: "Update Actual & Submit").
     - Section 3: Ad-hoc Transactions (searchable, filterable by payer/category/tag, sortable).
     - Action button: "+ Add Expense" with real-time split calculator.
  3. **Recurring / Budget**:
     - Template configuration for Fixed and Fluctuating expenses.
     - Settings: Name, Category, Default Amount, Due Day, Payer, Share allocation.
  4. **Inbox**:
     - Feed of parsed bank/UPI transaction alerts from email.
     - One-click filing into monthly ledger.
  5. **Settlement**:
     - Visual breakdown of bilateral obligations.
     - Pot calculation breakdown (Total Pot Spend, Common Income, Net Shortfall split).
     - "Record Settlement Payment" form (supports partial payments, advances, reference note).
     - "Close Month" action with snapshot verification.
  6. **Approvals**:
     - Pending requests requiring user action.
     - Actions: Accept, Decline, Return with clarification note.

---

## 8. Verification & Test Scenarios

The implementation must include comprehensive integration tests covering these seven mandatory scenarios:
1. **₹30,000 Furniture Split**: Bhawneet pays ₹30,000, split 50/50 with Gurneet. Settlement shows Gurneet owes Bhawneet ₹15,000.
2. **₹100 Three-Way Split**: ₹100 split across Bhawneet, Gurneet, and Common Account. Verified exact whole paise distribution: 33.34 to payer, 33.33 to the other two. Total equals exactly 100.00.
3. **Fixed Expense Auto-Roll**: ₹1,499 broadband bill configured as fixed recurring expense automatically appears in active month ledger on due date.
4. **Fluctuating Bill Actual Submission**: Grocery estimated at ₹10,000; user edits actual to ₹12,450. Active month updates immediately and recalculates net balance.
5. **Common Pot Spend Isolation**: ₹8,000 electricity bill paid by Common Family Account. Recorded as household spend, does NOT create debt between Bhawneet and Gurneet.
6. **Member Pays for Household**: Gurneet pays ₹6,000 for home maintenance allocated 100% to Common Account. Common pot records ₹6,000 spend; shortfall is funded 50/50 by Bhawneet and Gurneet, so Bhawneet owes Gurneet ₹3,000.
7. **Partial Settlement & Advance**: Gurneet owes Bhawneet ₹15,000, pays ₹10,000. Net balance reflects ₹5,000 remaining debt. If Gurneet pays ₹18,000, ₹3,000 is stored as an advance credit for next month.

---

## 9. Phased Execution Order for Claude Code

Instruct Claude Code to execute the build strictly in these 9 sequential steps, halting for review after each step:

- **Step 1: Project Setup & Database Foundations**
  - Scaffold Next.js 16 with React 19, TypeScript, Tailwind CSS, Lucide.
  - Setup Supabase Postgres 17 schema: tables for `users`, `expenses`, `expense_splits`, `recurring_templates`, `inbox_messages`, `settlements`, `audit_logs`.
  - Implement whole-paise integer storage and PostgreSQL RLS policies.
- **Step 2: Authentication & Security Subsystem**
  - Implement PBKDF2-SHA256 password hashing and verification.
  - Setup signed HTTP-only cookie sessions and device fingerprinting with email OTP.
  - Setup Upstash Redis rate limiting with local LRU fallback.
- **Step 3: Core Expense Data Layer**
  - Implement guarded Postgres server functions for creating, updating, soft-deleting expenses.
  - Enforce Zod validation on all input boundaries.
  - Implement 3-entity model (Bhawneet, Gurneet, Common Account).
- **Step 4: Recurring Bill Engine (Fixed vs. Fluctuating)**
  - Implement recurring template management.
  - Build automatic rollover for Fixed bills into "This Month".
  - Build editable "Enter Actual & Submit" workflow for Fluctuating bills.
- **Step 5: Settlement & Pot Math Engine**
  - Write pure mathematical functions for whole paise splitting and bilateral debt netting.
  - Implement Common Account pot isolation and shortfall distribution.
  - Write automated unit tests for all 7 scenario invariants.
- **Step 6: Approval State Machine & Concurrency Control**
  - Implement approval request creation for shared expenses.
  - Implement Accept, Decline, Return with notes, and atomic optimistic lock checks.
- **Step 7: Inbound Email Webhook & Bank Alert Parser**
  - Implement `/api/vault/inbox/mail` endpoint with SHA-256 API key authentication.
  - Build regex extraction engine for Indian bank/UPI SMS and email formats (HDFC, ICICI, SBI, Axis, Cred).
  - Build Inbox triage interface to convert alerts to expenses or bill payments.
- **Step 8: Full Frontend UI & Operational Tabs**
  - Implement Dashboard with clickable metric drill-downs.
  - Implement "This Month", "Recurring", "Inbox", "Settlement", and "Approvals" tabs.
  - Ensure responsive desktop and mobile layouts.
- **Step 9: Vercel Cron, S3 Storage & Final Verification**
  - Configure Vercel Cron `/api/vault/reminders/run` with `CRON_SECRET`.
  - Wire S3 presigned URL receipt uploads (Backblaze B2).
  - Run all integration test suites and verify deployment configuration for `lambafamily.vercel.app`.
