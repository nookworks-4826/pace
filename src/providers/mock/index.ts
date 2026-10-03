import { ManualFinancialProvider } from "../manual";
import type { ManualProviderSnapshot } from "../manual";

/** Fictional fixtures only. Never starts or writes into the user's ledger automatically. */
export class MockFinancialProvider extends ManualFinancialProvider {
  readonly id = "mock" as const;
  replaceSnapshot(snapshot: ManualProviderSnapshot) { this.snapshot = structuredClone(snapshot); }
}
