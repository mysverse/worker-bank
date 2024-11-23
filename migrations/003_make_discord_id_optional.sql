-- Step 2: Create a new table with 'discordId' as optional
CREATE TABLE transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT NOT NULL,
  amount REAL NOT NULL,
  bankName TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  discordId TEXT  -- Now optional (allows NULL)
);

-- Step 3: Copy data from the original table to the new table
INSERT INTO transactions_new (id, userId, amount, bankName, timestamp, discordId)
SELECT id, userId, amount, bankName, timestamp, discordId FROM transactions;

-- Step 4: Drop the original table
DROP TABLE transactions;

-- Step 5: Rename the new table to the original table's name
ALTER TABLE transactions_new RENAME TO transactions;
