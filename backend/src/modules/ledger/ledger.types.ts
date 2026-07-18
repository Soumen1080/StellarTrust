import type {
  CurrencyCode,
  EntryDirection,
  LedgerEntryInput,
  LedgerTransactionInput,
} from "@stellartrust/shared";

export type { LedgerEntryInput, LedgerTransactionInput };

export interface PersistedLedgerEntry {
  id: string;
  transactionId: string;
  accountId: string;
  direction: EntryDirection;
  amount: string; // minor units, non-negative integer string
  currency: CurrencyCode;
  createdAt: string;
}

export interface PersistedLedgerTransaction {
  id: string;
  referenceId: string;
  description: string;
  entries: PersistedLedgerEntry[];
  createdAt: string;
}
