# Supabase Setup Instructions

## 1. Create Supabase Project

1. Go to https://supabase.com and sign up or log in
2. Click "New Project"
3. Fill in your project details:
   - Name: `slash-backend` (or any name you prefer)
   - Database Password: Choose a strong password (save this!)
   - Region: Choose the closest region to you
4. Wait for the project to be provisioned (usually 1-2 minutes)

## 2. Get Your Credentials

1. In your Supabase project dashboard, go to **Settings** > **API**
2. Copy the following values:
   - **Project URL** (this is your `SUPABASE_URL`)
   - **service_role** key (this is your `SUPABASE_SERVICE_ROLE_KEY`)
   - ⚠️ **Important**: Use the `service_role` key, not the `anon` key. The service role key bypasses Row Level Security and is needed for server-side operations.

## 3. Create Database Tables

1. In your Supabase dashboard, go to **SQL Editor**
2. Click **New Query**
3. Copy and paste the following SQL:

```sql
-- Create transactions table (append-only log)
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw_request', 'withdraw')),
    amount NUMERIC NOT NULL,
    account_id TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create accounts table (current balances)
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    balance NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_type ON transactions(account_id, type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

-- Enable Row Level Security (RLS)
-- Note: We use service_role key which bypasses RLS, but it's good practice to enable it
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows service_role to do everything
-- (This is handled automatically by using service_role key, but explicit policies are good for clarity)
CREATE POLICY "Service role full access on transactions" ON transactions
    FOR ALL USING (true);

CREATE POLICY "Service role full access on accounts" ON accounts
    FOR ALL USING (true);
```

4. Click **Run** to execute the SQL

## 4. Create Database Function for Withdraw Request Check

This function handles the atomic check for withdraw requests with proper locking:

1. In the SQL Editor, create a new query and paste:

```sql
-- Function to check and validate withdraw request atomically
-- This function uses row-level locking to prevent race conditions
CREATE OR REPLACE FUNCTION check_withdraw_request(
    p_account_id TEXT,
    p_requested_amount NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_current_balance NUMERIC;
    v_pending_amount NUMERIC;
    v_available_balance NUMERIC;
BEGIN
    -- Lock the account row for update to prevent concurrent modifications
    SELECT balance INTO v_current_balance
    FROM accounts
    WHERE account_id = p_account_id
    FOR UPDATE;
    
    -- If account doesn't exist, create it with balance 0
    IF v_current_balance IS NULL THEN
        INSERT INTO accounts (account_id, balance)
        VALUES (p_account_id, 0)
        ON CONFLICT (account_id) DO NOTHING;
        v_current_balance := 0;
    END IF;
    
    -- Calculate pending approved withdraw_requests
    -- These are withdraw_requests that don't have a corresponding withdraw yet
    -- We match by checking if there's a withdraw with created_at >= withdraw_request.created_at
    SELECT COALESCE(SUM(t.amount), 0) INTO v_pending_amount
    FROM transactions t
    WHERE t.account_id = p_account_id
      AND t.type = 'withdraw_request'
      AND NOT EXISTS (
          SELECT 1
          FROM transactions w
          WHERE w.account_id = t.account_id
            AND w.type = 'withdraw'
            AND w.created_at >= t.created_at
      );
    
    -- Available balance = current balance - pending approved requests
    v_available_balance := v_current_balance - COALESCE(v_pending_amount, 0);
    
    -- Approve if available balance is sufficient
    IF v_available_balance >= p_requested_amount THEN
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$$;
```

2. Click **Run** to execute

## 5. Set Environment Variables

You have two options:

### Option A: Using docker-compose.yaml (Recommended for local development)

Edit `docker-compose.yaml` and add your credentials to the `environment` section:

```yaml
environment:
  - NODE_ENV=production
  - PORT=3000
  - SUPABASE_URL=your_project_url_here
  - SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

### Option B: Using .env file

1. Copy `.env.example` to `.env`
2. Fill in your Supabase credentials

## 6. Verify Setup

1. Run `npm install` to install dependencies
2. Start your server: `npm run build && node dist/server.js`
3. The server should start without errors

## Troubleshooting

- **Error: Missing Supabase credentials**: Make sure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set in your environment
- **Error: relation "transactions" does not exist**: Make sure you ran the SQL to create the tables
- **Error: function "check_withdraw_request" does not exist**: Make sure you created the database function

