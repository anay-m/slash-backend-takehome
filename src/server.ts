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

interface AccountBalance {
	accountId: string;
	balance: number;
}

// Process a transaction
app.post("/transaction", async (req, res) => {
	const transaction: Transaction = req.body;

	try {
		switch (transaction.type) {
			case "deposit": {
				// Insert transaction into log
				await insertTransaction(transaction);
				// Update account balance atomically
				await incrementAccountBalance(transaction.accountId, transaction.amount);
				res.status(200).end();
				break;
			}

			case "withdraw_request": {
				// Use database transaction with row-level locking to check balance
				// Must respond within 3 seconds
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 3000),
				);

				try {
					const approved = await Promise.race([
						checkAndReserveBalance(
							transaction.accountId,
							transaction.amount,
						),
						timeoutPromise,
					]) as boolean;

					if (approved) {
						// Insert the withdraw_request into log (for audit trail)
						await insertTransaction(transaction);
						res.status(201).end();
					} else {
						// Insert the withdraw_request into log even if denied (for audit trail)
						await insertTransaction(transaction);
						res.status(402).end();
					}
				} catch (error) {
					if (error instanceof Error && error.message === "Timeout") {
						// Timeout - reject the request
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
				// Update account balance atomically (can go negative per spec)
				await decrementAccountBalance(transaction.accountId, transaction.amount);
				res.status(200).end();
				break;
			}

			default:
				res.status(400).json({
					message: "Invalid transaction type",
					transaction,
				});
		}
	} catch (error) {
		console.error("Error processing transaction:", error);
		res.status(500).json({
			message: "Internal server error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
});

// Get account balance
app.get("/account/:accountId", async (req, res) => {
	const { accountId } = req.params;

	try {
		const balance = await getAccountBalance(accountId);
		res.status(200).json({ accountId, balance });
	} catch (error) {
		console.error("Error getting account balance:", error);
		res.status(500).json({
			message: "Internal server error",
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
});

export default app;
