-- Migration: Add discordId column to transactions table

ALTER TABLE transactions
ADD COLUMN discordId TEXT;