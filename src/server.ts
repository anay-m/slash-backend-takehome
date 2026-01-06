import express from "express";
import {
	insertTransaction,
	getAccountBalance,
	incrementAccountBalance,
	decrementAccountBalance,
	checkAndReserveBalance,
	type Transaction,
} from "./db.js";

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
	const startTime = Date.now();
	const timestamp = new Date().toISOString();

	console.log(`[${timestamp}] ${req.method} ${req.path}`, {
		accountId: req.params.accountId || req.body?.accountId,
		transactionId: req.body?.id,
		transactionType: req.body?.type,
	});

	// Log response when finished
	res.on("finish", () => {
		const duration = Date.now() - startTime;
		console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
	});

	next();
});

interface AccountBalance {
	accountId: string;
	balance: number;
}

// Process a transaction
app.post("/transaction", async (req, res) => {
	const transaction: Transaction = req.body;
	const startTime = Date.now();

	try {
		console.log(`Processing transaction: ${transaction.id}`, {
			type: transaction.type,
			accountId: transaction.accountId,
			amount: transaction.amount,
		});

		switch (transaction.type) {
			case "deposit": {
				// Insert transaction into log
				await insertTransaction(transaction);
				console.log(`Transaction ${transaction.id} inserted into log`);

				// Update account balance atomically
				await incrementAccountBalance(transaction.accountId, transaction.amount);
				const newBalance = await getAccountBalance(transaction.accountId);

				console.log(`Deposit successful: ${transaction.id}`, {
					accountId: transaction.accountId,
					amount: transaction.amount,
					newBalance,
					duration: `${Date.now() - startTime}ms`,
				});

				res.status(200).end();
				break;
			}

			case "withdraw_request": {
				// Use database transaction with row-level locking to check balance
				// Must respond within 3 seconds
				const checkStartTime = Date.now();
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 3000),
				);

				try {
					console.log(`Checking withdraw_request: ${transaction.id}`, {
						accountId: transaction.accountId,
						requestedAmount: transaction.amount,
					});

					const approved = await Promise.race([
						checkAndReserveBalance(
							transaction.accountId,
							transaction.amount,
						),
						timeoutPromise,
					]) as boolean;

					const checkDuration = Date.now() - checkStartTime;
					const currentBalance = await getAccountBalance(transaction.accountId);

					if (approved) {
						// Insert the withdraw_request into log (for audit trail)
						await insertTransaction(transaction);

						console.log(`Withdraw request APPROVED: ${transaction.id}`, {
							accountId: transaction.accountId,
							requestedAmount: transaction.amount,
							currentBalance,
							checkDuration: `${checkDuration}ms`,
							totalDuration: `${Date.now() - startTime}ms`,
						});

						res.status(201).end();
					} else {
						// Insert the withdraw_request into log even if denied (for audit trail)
						await insertTransaction(transaction);

						console.log(`Withdraw request DENIED: ${transaction.id}`, {
							accountId: transaction.accountId,
							requestedAmount: transaction.amount,
							currentBalance,
							reason: "Insufficient balance",
							checkDuration: `${checkDuration}ms`,
							totalDuration: `${Date.now() - startTime}ms`,
						});

						res.status(402).end();
					}
				} catch (error) {
					if (error instanceof Error && error.message === "Timeout") {
						// Timeout - reject the request
						console.warn(`Withdraw request TIMEOUT: ${transaction.id}`, {
							accountId: transaction.accountId,
							requestedAmount: transaction.amount,
							duration: `${Date.now() - startTime}ms`,
						});
						res.status(402).end();
					} else {
						throw error;
					}
				}
				break;
			}

			case "withdraw": {
				// Insert transaction into log
				await insertTransaction(transaction);
				console.log(`Transaction ${transaction.id} inserted into log`);

				// Update account balance atomically (can go negative per spec)
				await decrementAccountBalance(transaction.accountId, transaction.amount);
				const newBalance = await getAccountBalance(transaction.accountId);

				console.log(`Withdraw successful: ${transaction.id}`, {
					accountId: transaction.accountId,
					amount: transaction.amount,
					newBalance,
					duration: `${Date.now() - startTime}ms`,
				});

				res.status(200).end();
				break;
			}

			default:
				console.warn(`Invalid transaction type: ${transaction.type}`, {
					transactionId: transaction.id,
					accountId: transaction.accountId,
				});
				res.status(400).json({
					message: "Invalid transaction type",
					transaction,
				});
				return;
		}
	} catch (error) {
		console.error(`Error processing transaction ${transaction.id}:`, {
			transactionId: transaction.id,
			type: transaction.type,
			accountId: transaction.accountId,
			error: error instanceof Error ? error.message : "Unknown error",
			stack: error instanceof Error ? error.stack : undefined,
			duration: `${Date.now() - startTime}ms`,
		});
		res.status(500).json({
			message: "Internal server error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
});

// Get account balance
app.get("/account/:accountId", async (req, res) => {
	const { accountId } = req.params;
	const startTime = Date.now();

	try {
		const balance = await getAccountBalance(accountId);

		console.log(`Balance retrieved for account: ${accountId}`, {
			accountId,
			balance,
			duration: `${Date.now() - startTime}ms`,
		});

		res.status(200).json({ accountId, balance });
	} catch (error) {
		console.error(`Error getting account balance for ${accountId}:`, {
			accountId,
			error: error instanceof Error ? error.message : "Unknown error",
			stack: error instanceof Error ? error.stack : undefined,
			duration: `${Date.now() - startTime}ms`,
		});
		res.status(500).json({
			message: "Internal server error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("=".repeat(50));
	console.log(`Server started successfully`);
	console.log(`Port: ${PORT}`);
	console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
	console.log(`Supabase URL: ${process.env.SUPABASE_URL ? "Configured" : "NOT SET"}`);
	console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "Configured" : "NOT SET"}`);
	console.log(`Timestamp: ${new Date().toISOString()}`);
	console.log("=".repeat(50));
});

export default app;
