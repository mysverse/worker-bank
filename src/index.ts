import { z } from 'zod';

const TransactionRequestSchema = z.object({
	amount: z.number().refine((val) => val !== 0, { message: 'Amount cannot be zero' }),
	userId: z.string().min(1),
	discordId: z.string().optional(),
	transactionType: z.enum(['debit', 'credit']).optional(),
	bankName: z.string().min(1).optional(),
});

type TransactionType = z.infer<typeof TransactionRequestSchema>['transactionType'];

interface RobloxData {
	bandar_ringgit?: number;
}

async function processTransaction(env: Env, userId: string, amount: number) {
	// Step 1: Get the latest data key
	const datastoreName = `DATA/${userId}`;
	const { latestDataKey } = await getLatestDataKeyAndETag(env, datastoreName, userId);

	// Step 2: Fetch data from standard DataStore
	const data = await getData(env, datastoreName, latestDataKey);

	// Step 3: Modify the data
	const { before, after, newData: modifiedData } = modifyData(data, amount);

	// Step 4: Save the data using conditional update
	await saveData(env, datastoreName, modifiedData, latestDataKey);

	return { before, after };
}

async function getLatestDataKeyAndETag(env: Env, orderedDataStoreName: string, userId: string): Promise<{ latestDataKey: string }> {
	const { ROBLOX_API_KEY, UNIVERSE_ID } = env;

	const scope = 'global';
	const maxPageSize = 1;
	const orderBy = 'value desc';

	const url = `https://apis.roblox.com/cloud/v2/universes/${UNIVERSE_ID}/ordered-data-stores/${encodeURIComponent(
		orderedDataStoreName
	)}/scopes/${scope}/entries?maxPageSize=${maxPageSize}&orderBy=${orderBy}`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'x-api-key': ROBLOX_API_KEY,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) throw new Error('Failed to fetch entries from Ordered DataStore');

	const data = (await response.json()) as any;

	if (!data.orderedDataStoreEntries || data.orderedDataStoreEntries.length === 0) {
		throw new Error('No entries found in Ordered DataStore for this user');
	}

	const latestEntry = data.orderedDataStoreEntries[0];
	const latestDataKey = latestEntry.id as string;

	return { latestDataKey };
}

async function getData(env: Env, dataStoreName: string, dataKey: string): Promise<RobloxData> {
	const { ROBLOX_API_KEY, UNIVERSE_ID } = env;

	const url = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry?datastoreName=${dataStoreName}&entryKey=${encodeURIComponent(
		dataKey
	)}`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'x-api-key': ROBLOX_API_KEY,
		},
	});

	if (!response.ok) throw new Error('Failed to fetch data from DataStore');

	const data: RobloxData = await response.json();

	return data;
}

interface TransactionResult {
	before: number;
	after: number;
	newData: RobloxData;
}

function modifyData(data: RobloxData, amount: number): TransactionResult {
	const before = data.bandar_ringgit || 0;
	if (before + amount < 0) {
		throw new Error('Insufficient funds to perform this transaction');
	}
	data.bandar_ringgit = (data.bandar_ringgit || 0) + amount;
	const after = data.bandar_ringgit || 0;
	return { before, after, newData: data };
}

async function saveData(env: Env, dataStoreName: string, data: RobloxData, dataKey: string): Promise<void> {
	const { ROBLOX_API_KEY, UNIVERSE_ID } = env;

	const url = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry?datastoreName=${dataStoreName}&entryKey=${encodeURIComponent(
		dataKey
	)}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'x-api-key': ROBLOX_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(data),
	});

	if (response.status === 412) {
		throw new Error('Data has been modified by another process');
	}

	if (!response.ok) throw new Error('Failed to save data to DataStore');

	// No need to create a new backup in Ordered DataStore
}

async function sendInGameUpdate(
	env: Env,
	userId: string,
	amount: number,
	bankName: string,
	transactionType: TransactionType
): Promise<void> {
	const { ROBLOX_API_KEY, UNIVERSE_ID } = env;
	const topic = 'UpdateCurrency';

	const messageContent = {
		userId,
		amount,
		bankName,
		transactionType,
	};

	const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${encodeURIComponent(topic)}`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'x-api-key': ROBLOX_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ message: JSON.stringify(messageContent) }),
	});

	// if (!response.ok) throw new Error('Failed to send in-game update');
	if (!response.ok) console.error('Failed to send in-game update');
}

async function logTransaction(env: Env, userId: string, amount: number, bankName: string, discordId?: string): Promise<number> {
	const query = `
	  INSERT INTO transactions (userId, amount, bankName, discordId)
	  VALUES (?, ?, ?, ?);
	`;
	const stmt = env.DB.prepare(query).bind(userId, amount, bankName, discordId ?? null);
	const result = await stmt.run();
	if (!result.success) throw new Error('Failed to log transaction');
	return result.meta.last_row_id;
}

// Get transactions
interface Transaction {
	id: number;
	amount: number;
	timestamp: string;
}

interface DiscordResult {
	discordId: string;
}

async function getDiscordId(env: Env, userId: string, bankName: string) {
	const query = `
	  SELECT discordId FROM transactions
	  WHERE userId = ?
	  AND bankName = ?
	  AND discordId IS NOT NULL
	  ORDER BY timestamp DESC
	  LIMIT 1;
	`;
	const stmt = env.DB.prepare(query).bind(userId, bankName);
	const result = await stmt.first<DiscordResult>();
	return result?.discordId;
}

async function getTransactions(env: Env, userId: string, bankName: string) {
	const query = `
	  SELECT id, amount, timestamp FROM transactions
	  WHERE userId = ?
	  AND bankName = ?
	  ORDER BY timestamp DESC;
	`;
	const stmt = env.DB.prepare(query).bind(userId, bankName);
	const result = await stmt.run<Transaction>();
	return result.results;
}

async function rollbackTransactionLog(env: Env, id: number): Promise<void> {
	const query = `
      DELETE FROM transactions
      WHERE id = ?;
    `;
	const stmt = env.DB.prepare(query).bind(id);
	const result = await stmt.run();
	if (!result.success) throw new Error('Failed to rollback transaction log');
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const url = new URL(request.url);

			// Authenticate the request
			const apiKey = request.headers.get('Authorization');
			if (!apiKey) {
				return new Response('Unauthorized', { status: 401 });
			}

			// Verify API key
			const bankName = await env.API_KEYS.get(apiKey);
			if (!bankName) {
				return new Response('Forbidden', { status: 403 });
			}

			if (url.pathname === '/transactions') {
				const userId = url.searchParams.get('userId');
				if (!userId) {
					return new Response('Invalid input', { status: 400 });
				}
				const overrideBankName = url.searchParams.get('bankName');
				const finalBankName = overrideBankName ?? bankName;
				const transactions = await getTransactions(env, userId, finalBankName);
				const discordId = await getDiscordId(env, userId, finalBankName);
				return Response.json({
					transactions: transactions.map((transaction) => ({
						id: transaction.id,
						amount: transaction.amount,
						timestamp: new Date(transaction.timestamp).toISOString(),
					})),
					metadata: {
						discordId,
						bankName: finalBankName,
					},
				});
			}

			// Parse and validate request body
			const requestBody = await request.json();
			const parseResult = TransactionRequestSchema.safeParse(requestBody);
			if (!parseResult.success) {
				return new Response('Invalid input', { status: 400 });
			}
			const { amount: absoluteAmount, userId, discordId, transactionType, bankName: overrideBankName } = parseResult.data;

			const finalTransactionType: TransactionType = transactionType ?? 'debit';
			const finalBankName = overrideBankName ?? bankName;
			// Convert the amount to negative if it's a withdrawal
			const amount = finalTransactionType === 'credit' ? -absoluteAmount : absoluteAmount;

			// Log the transaction
			const transactionId = await logTransaction(env, userId, amount, finalBankName, discordId);

			try {
				// Process the transaction and send in-game update
				const result = await processTransaction(env, userId, amount);
				await sendInGameUpdate(env, userId, absoluteAmount, finalBankName, finalTransactionType);
				return Response.json({
					success: true,
					result,
					bankName: finalBankName,
					transactionType: finalTransactionType,
					metadata: {
						discordId,
					},
				});
			} catch (error) {
				await rollbackTransactionLog(env, transactionId);
				throw error;
			}
		} catch (error: unknown) {
			let message = 'Unknown';
			if (error instanceof Error) {
				message = error.message;
			}
			return Response.json({ success: false, error: message }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
