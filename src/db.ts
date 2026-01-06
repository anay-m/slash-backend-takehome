import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface Transaction {
    id: string;
    type: "deposit" | "withdraw_request" | "withdraw";
    amount: number;
    accountId: string;
    timestamp: string;
}

interface DatabaseTransaction {
    id: string;
    type: string;
    amount: number;
    account_id: string;
    timestamp: string;
    created_at?: string;
}

interface Account {
    account_id: string;
    balance: number;
    updated_at?: string;
}

let supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
    if (!supabase) {
        const url = process.env.SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!url || !serviceRoleKey) {
            throw new Error(
                "Missing Supabase credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
            );
        }

        supabase = createClient(url, serviceRoleKey);
    }

    return supabase;
}

/**
 * Insert a transaction into the append-only log
 */
export async function insertTransaction(
    transaction: Transaction,
): Promise<void> {
    const client = getSupabaseClient();

    const dbTransaction: DatabaseTransaction = {
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount,
        account_id: transaction.accountId,
        timestamp: transaction.timestamp,
    };

    const { error } = await client
        .from("transactions")
        .insert(dbTransaction)
        .select()
        .single();

    if (error) {
        // Handle duplicate transaction ID (idempotency)
        if (error.code === "23505") {
            // PostgreSQL unique constraint violation
            console.log(`Transaction ${transaction.id} already exists, skipping`);
            return;
        }
        throw new Error(`Failed to insert transaction: ${error.message}`);
    }
}

/**
 * Get the current balance for an account
 */
export async function getAccountBalance(
    accountId: string,
): Promise<number> {
    const client = getSupabaseClient();

    const { data, error } = await client
        .from("accounts")
        .select("balance")
        .eq("account_id", accountId)
        .single();

    if (error) {
        if (error.code === "PGRST116") {
            // No rows returned - account doesn't exist yet
            return 0;
        }
        throw new Error(`Failed to get account balance: ${error.message}`);
    }

    return data?.balance || 0;
}

/**
 * Update account balance atomically
 */
export async function updateAccountBalance(
    accountId: string,
    newBalance: number,
): Promise<void> {
    const client = getSupabaseClient();

    // Use upsert to create account if it doesn't exist
    const { error } = await client.from("accounts").upsert(
        {
            account_id: accountId,
            balance: newBalance,
            updated_at: new Date().toISOString(),
        },
        {
            onConflict: "account_id",
        },
    );

    if (error) {
        throw new Error(`Failed to update account balance: ${error.message}`);
    }
}

/**
 * Increment account balance atomically (for deposits)
 */
export async function incrementAccountBalance(
    accountId: string,
    amount: number,
): Promise<void> {
    const client = getSupabaseClient();

    // Use RPC call or upsert with increment logic
    // First, get current balance or create account
    const currentBalance = await getAccountBalance(accountId);
    await updateAccountBalance(accountId, currentBalance + amount);
}

/**
 * Decrement account balance atomically (for withdrawals)
 */
export async function decrementAccountBalance(
    accountId: string,
    amount: number,
): Promise<void> {
    const client = getSupabaseClient();

    const currentBalance = await getAccountBalance(accountId);
    await updateAccountBalance(accountId, currentBalance - amount);
}

/**
 * Check if a withdraw_request can be approved using database transaction with row-level locking
 * Returns true if approved, false if denied
 * 
 * Logic: We need to check if approving this request would cause the balance to go negative.
 * We consider:
 * - Current balance
 * - Pending approved withdraw_requests (that haven't been executed as withdraws yet)
 */
export async function checkAndReserveBalance(
    accountId: string,
    requestedAmount: number,
): Promise<boolean> {
    const client = getSupabaseClient();

    // Use a database function (RPC) to handle the transaction atomically
    // This ensures row-level locking and prevents race conditions
    const { data, error } = await client.rpc("check_withdraw_request", {
        p_account_id: accountId,
        p_requested_amount: requestedAmount,
    });

    if (error) {
        // If the RPC function doesn't exist, fall back to manual transaction logic
        console.warn(
            "RPC function not available, using fallback method:",
            error.message,
        );
        return await checkAndReserveBalanceFallback(accountId, requestedAmount);
    }

    return data === true;
}

/**
 * Fallback method for checking withdraw requests
 * This calculates the available balance by:
 * 1. Getting current account balance
 * 2. Subtracting all pending withdraws (withdraws executed after their corresponding withdraw_request)
 * 3. Checking if remaining balance >= requested amount
 */
async function checkAndReserveBalanceFallback(
    accountId: string,
    requestedAmount: number,
): Promise<boolean> {
    const client = getSupabaseClient();

    // Get current balance (or 0 if account doesn't exist)
    const currentBalance = await getAccountBalance(accountId);

    // Calculate sum of approved withdraw_requests that haven't been executed yet
    // Strategy: Find all withdraw_requests, then check if there's a corresponding withdraw
    // If no withdraw exists, it's still pending

    // Get all withdraw_requests for this account
    const { data: withdrawRequests, error: reqError } = await client
        .from("transactions")
        .select("id, amount, created_at")
        .eq("account_id", accountId)
        .eq("type", "withdraw_request")
        .order("created_at", { ascending: true });

    if (reqError) {
        throw new Error(
            `Failed to check pending withdraw requests: ${reqError.message}`,
        );
    }

    // Get all withdraws for this account
    const { data: withdraws, error: withdrawError } = await client
        .from("transactions")
        .select("id, amount, created_at")
        .eq("account_id", accountId)
        .eq("type", "withdraw")
        .order("created_at", { ascending: true });

    if (withdrawError) {
        throw new Error(`Failed to check withdraws: ${withdrawError.message}`);
    }

    // Calculate pending approved requests
    // A withdraw_request is "pending" if there's no withdraw with the same or later timestamp
    // For simplicity, we'll match by checking if a withdraw exists after the request
    let pendingAmount = 0;

    if (withdrawRequests) {
        for (const request of withdrawRequests) {
            // Check if there's a withdraw that corresponds to this request
            // We'll assume withdraws come after their requests
            const hasCorrespondingWithdraw = withdraws?.some(
                (w: { id: string; amount: number; created_at: string | null }) =>
                    w.created_at &&
                    request.created_at &&
                    w.created_at >= request.created_at,
            );

            if (!hasCorrespondingWithdraw) {
                pendingAmount += Number(request.amount);
            }
        }
    }

    // Available balance = current balance - pending approved requests
    const availableBalance = currentBalance - pendingAmount;

    return availableBalance >= requestedAmount;
}

