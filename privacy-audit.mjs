/** Source and disposable-storage audit. Never opens a user's browser profile. */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const record = (name, details) => {
  checks.push({ name, passed: true, ...details });
  console.log(`✓ ${name}`);
};
const contents = async (file) => readFile(path.join(root, file), "utf8");
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (relative !== "src/tests")
        files.push(...(await sourceFiles(relative)));
    } else if (/\.(?:ts|tsx|js)$/.test(entry.name)) files.push(relative);
  }
  return files;
}
function fail(message) {
  throw new Error(message);
}
async function auditSources() {
  const files = await sourceFiles("src");
  const browserStorage = [];
  const network = [];
  for (const file of files) {
    const source = await contents(file);
    if (/\bclient[_-]?secret\b/i.test(source))
      fail(`${file}: client secret is forbidden in browser code`);
    // Conservative source checks also inspect literals/computed property names.
    // They complement real persistence tests; they are not a general taint analyzer.
    if (/\b(?:localStorage|sessionStorage)\b/.test(source)) {
      if (file !== "src/domain/security.ts")
        fail(
          `${file}: browser storage is reserved for public screen-lock metadata`,
        );
      browserStorage.push(file);
    }
    if (/\bcaches\b/.test(source))
      fail(`${file}: application records must not use CacheStorage`);
    if (/\b(?:sendBeacon|WebSocket|XMLHttpRequest)\b/.test(source))
      fail(`${file}: unreviewed network channel`);
    if (/\bconsole\s*(?:\.|\[)/.test(source))
      fail(`${file}: runtime console output is forbidden`);
    if (/\bfetch\b/.test(source)) network.push(file);
  }
  const lock = await contents("src/domain/security.ts");
  assert.match(lock, /pace:local-lock:v1/);
  assert.match(lock, /pace:passkey-label:v1/);
  assert.match(lock, /const configSchema = z\.discriminatedUnion/);
  assert.doesNotMatch(
    lock,
    /accessToken|refreshToken|imageBase64|snapshotBalance/,
  );
  record(
    "Runtime source excludes plaintext browser storage, console output and client secrets",
    {
      sourceFiles: files.length,
      publicMetadataStorage: [...new Set(browserStorage)],
      networkCallSites: [...new Set(network)],
    },
  );

  const provider = await contents("src/providers/moneytree/index.ts");
  for (const policy of [
    /cache:\s*['"]no-store['"]/,
    /credentials:\s*['"]omit['"]/,
    /redirect:\s*['"]error['"]/,
    /referrerPolicy:\s*['"]no-referrer['"]/,
  ])
    assert.match(provider, policy);
  assert.match(provider, /url\.origin !== moneytreeEndpoints\(config\)\.api/);
  assert.match(provider, /url\.pathname\.startsWith\(['"]\/link\/['"]\)/);
  const oauth = await contents("src/providers/moneytree/pkce.ts");
  assert.match(oauth, /replaceUrl\(url\.href\)/);
  assert.match(oauth, /url\.searchParams\.delete\(key\)/);
  record(
    "Moneytree API restricts token destination and disables browser response caching",
  );

  const vite = await contents("vite.config.ts");
  assert.match(vite, /registerType:\s*['"]prompt['"]/);
  assert.match(vite, /globIgnores:\s*\[['"]\*\*\/ocr\/\*\*['"]\]/);
  assert.match(vite, /url\.origin\s*===\s*self\.location\.origin/);
  assert.match(vite, /pace-ocr-static-v7/);
  assert.match(vite, /traineddata\\\.gz/);
  assert.doesNotMatch(
    vite,
    /getmoneytree|accounts\.json|transactions\.json|oauth\/token|imageBase64/,
  );
  const push = await contents("public/sw-notifications.js");
  assert.match(push, /今日のPaceを確認してください/);
  assert.doesNotMatch(
    push,
    /event\.data|indexedDB|localStorage|accessToken|snapshotBalance|amount/,
  );
  const ocr = await contents("src/features/ReceiptCapture.tsx");
  assert.match(ocr, /cacheMethod:\s*['"]none['"]/);
  assert.match(ocr, /workerBlobURL:\s*false/);
  assert.match(ocr, /const base = new URL/);
  assert.match(ocr, /document\.baseURI/);
  assert.match(ocr, /if\s*\(saveImage\s*&&\s*file\)/);
  assert.match(ocr, /setSaveImage\(false\)/);
  assert.doesNotMatch(ocr, /https?:\/\/|\bfetch\s*\(/);
  record(
    "Service Worker caches static app/OCR assets only; receipt image saving is explicit and OCR remains local",
  );
}

const stamp = {
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
};
const date = "2026-10-03";
const marker = "PRIVATE-AUDIT-FICTIONAL-";
const phrase = "fictional audit independent vault passphrase";
const token = `${marker}TOKEN-NEVER-A-REAL-TOKEN`;
const imageBase64 = Buffer.from(`${marker}RECEIPT-BITMAP`).toString("base64");
function fixture(defaultSettings, defaultCategories) {
  const category = { categoryId: "food", subcategoryId: "food-0" };
  const credentialMetadata = {
    providerId: "mock",
    connectionId: "connection",
    externalTransactionId: `${marker}external-id`,
    externalAccountId: "ext-bank",
    balanceEffect: "snapshot",
  };
  const bank = {
    ...stamp,
    id: "bank",
    name: `${marker}BANK-NAME`,
    kind: "BANK",
    institutionName: `${marker}INSTITUTION`,
    currency: "JPY",
    snapshotBalance: 50000,
    balanceAsOf: date,
    snapshotRecordedAt: stamp.createdAt,
    balanceSource: "provider",
    providerId: "mock",
    connectionId: "connection",
    externalAccountId: "ext-bank",
    isSpendable: true,
    isActive: true,
    automationLevel: "automatic",
  };
  return {
    settings: [
      {
        ...structuredClone(defaultSettings),
        openingLiquidBalance: 50000,
        lastSeenMonth: "2026-10",
        financialAutomationEnabled: true,
        salarySchedule: {
          payday: 10,
          expectedAmount: 210000,
          variableIncome: true,
        },
      },
    ],
    categories: structuredClone(defaultCategories).map((entry) =>
      entry.id === "food"
        ? { ...entry, name: `${marker}CUSTOM-CATEGORY` }
        : entry,
    ),
    expenses: [
      {
        ...stamp,
        ...category,
        ...credentialMetadata,
        id: "expense",
        amount: 850,
        date,
        merchant: `${marker}MERCHANT`,
        description: `${marker}DESCRIPTION`,
        paymentMethod: "bank",
        sourceAccountId: "bank",
        memo: `${marker}EXPENSE-MEMO`,
        isFixedCost: true,
        recurringOccurrenceId: "recurring:2026-10",
        receiptId: "receipt",
      },
    ],
    incomes: [
      {
        ...stamp,
        id: "income",
        amount: 210000,
        date,
        source: `${marker}SALARY-SOURCE`,
        memo: `${marker}SALARY-MEMO`,
        type: "salary",
        sourceAccountId: "bank",
      },
    ],
    cards: [
      {
        ...stamp,
        id: "card",
        name: `${marker}CARD-NAME`,
        last4: "1234",
        closingDay: 31,
        paymentDay: 27,
        paymentMonthOffset: 1,
        openingOutstanding: 1500,
        isActive: true,
      },
    ],
    cardPayments: [
      {
        ...stamp,
        id: "card-payment",
        creditCardId: "card",
        amount: 500,
        date,
        memo: `${marker}CARD-PAYMENT`,
        sourceAccountId: "bank",
      },
    ],
    debts: [
      {
        ...stamp,
        id: "debt",
        lenderName: `${marker}LENDER`,
        title: `${marker}DEBT`,
        originalAmount: 10000,
        openingBalance: 10000,
        currentBalance: 9000,
        startedAt: date,
        plannedMonthlyPayment: 1000,
        nextPaymentDate: "2026-11-03",
        note: `${marker}DEBT-NOTE`,
        isEstimated: false,
        cashReceived: false,
        status: "active",
      },
    ],
    repayments: [
      {
        id: "repayment",
        debtId: "debt",
        amount: 1000,
        date,
        memo: `${marker}REPAYMENT`,
        sourceAccountId: "bank",
      },
    ],
    recurringExpenses: [
      {
        id: "recurring",
        ...category,
        name: `${marker}FIXED-COST`,
        amount: 850,
        paymentMethod: "bank",
        frequency: "monthly",
        dueDay: 3,
        startDate: date,
        isActive: true,
        note: `${marker}FIXED-NOTE`,
        sourceAccountId: "bank",
      },
    ],
    recurringOccurrences: [
      {
        id: "recurring:2026-10",
        recurringExpenseId: "recurring",
        dueDate: date,
        status: "paid",
        expenseId: "expense",
      },
    ],
    savingsGoals: [
      {
        id: "goal",
        name: `${marker}SAVINGS`,
        targetAmount: 10000,
        openingAmount: 100,
        currentAmount: 2000,
        targetDate: "2027-01-03",
        monthlyTarget: 500,
        createdAt: stamp.createdAt,
      },
    ],
    savingsContributions: [
      {
        id: "contribution",
        savingsGoalId: "goal",
        amount: 1900,
        date,
        memo: `${marker}SAVINGS-MEMO`,
        sourceAccountId: "bank",
      },
    ],
    budgets: [
      {
        ...stamp,
        id: "budget",
        year: 2026,
        month: 10,
        totalBudget: 20000,
        categoryBudgets: { food: 20000 },
      },
    ],
    merchantRules: [
      {
        normalizedMerchant: `${marker}LEARNED-MERCHANT`,
        ...category,
        usageCount: 1,
        lastUsedAt: stamp.createdAt,
      },
    ],
    balanceAdjustments: [
      {
        id: "balance-adjustment",
        previousBalance: 51000,
        newBalance: 50000,
        difference: -1000,
        date,
        memo: `${marker}LEGACY-BALANCE`,
      },
    ],
    dailyCheckIns: [
      { date, noSpendingConfirmed: false, confirmedAt: stamp.createdAt },
    ],
    favorites: [
      {
        id: "favorite",
        name: `${marker}FAVORITE`,
        amount: 850,
        merchant: `${marker}FAVORITE-MERCHANT`,
        ...category,
        paymentMethod: "cash",
        sourceAccountId: "cash",
      },
    ],
    drafts: [
      {
        id: "expense",
        value: JSON.stringify({
          amount: "850",
          merchant: `${marker}DRAFT-MERCHANT`,
          memo: `${marker}DRAFT-MEMO`,
        }),
      },
    ],
    accounts: [
      bank,
      {
        ...bank,
        id: "cash",
        name: `${marker}CASH`,
        kind: "CASH",
        snapshotBalance: 5000,
        balanceSource: "manual",
        providerId: undefined,
        connectionId: undefined,
        externalAccountId: undefined,
        automationLevel: "manual",
      },
    ],
    transfers: [
      {
        ...stamp,
        id: "transfer",
        fromAccountId: "bank",
        toAccountId: "cash",
        amount: 1000,
        date,
        memo: `${marker}TRANSFER`,
        fromBalanceEffect: "snapshot",
        toBalanceEffect: "ledger",
        status: "confirmed",
      },
    ],
    financialConnections: [
      {
        ...stamp,
        id: "connection",
        providerId: "mock",
        status: "connected",
        institutionIds: [`${marker}BANK-ID`],
        consentedAt: stamp.createdAt,
      },
    ],
    externalTransactions: [
      {
        ...stamp,
        ...credentialMetadata,
        id: "external",
        accountId: "bank",
        date,
        amount: -850,
        description: `${marker}EXTERNAL-TRANSACTION`,
        currency: "JPY",
        pendingStatus: "posted",
        externalUpdatedAt: stamp.createdAt,
        kind: "expense",
        linkedRecordId: "expense",
      },
    ],
    syncStates: [
      {
        id: "connection",
        lastAttemptAt: stamp.createdAt,
        lastSuccessAt: stamp.createdAt,
        nextRefreshAllowedAt: null,
        status: "idle",
        message: `${marker}SYNC`,
      },
    ],
    receipts: [
      {
        ...stamp,
        id: "receipt",
        expenseId: "expense",
        mimeType: "image/jpeg",
        imageBase64,
      },
    ],
    salaryRules: [
      {
        ...stamp,
        id: "salary-rule",
        accountId: "bank",
        normalizedDescription: `${marker}SALARY-RULE`,
        enabled: true,
      },
    ],
    financialAudits: [
      {
        ...stamp,
        id: "audit",
        action: "match",
        recordId: "transfer",
        detail: `${marker}FINANCIAL-AUDIT`,
      },
    ],
    accountAdjustments: [
      {
        ...stamp,
        id: "account-adjustment",
        accountId: "cash",
        previousBalance: 5500,
        newBalance: 5000,
        date,
        memo: `${marker}ACCOUNT-ADJUSTMENT`,
      },
    ],
  };
}
async function rawRows(database, table) {
  return new Promise((resolve, reject) => {
    const tx = database.backendDB().transaction(table, "readonly");
    const request = tx.objectStore(table).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function sameRecords(actual, expected) {
  assert.deepEqual(
    actual.map((row) => JSON.stringify(row)).sort(),
    expected.map((row) => JSON.stringify(row)).sort(),
  );
}
async function auditDisposableStorage() {
  // Vite transforms repository TypeScript without changing the production bundle.
  const server = await createServer({
    configFile: false,
    root,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    appType: "custom",
    logLevel: "error",
  });
  const databases = [];
  let PaceDatabase;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Network is disabled during the privacy audit");
  };
  try {
    console.log("Auditing disposable IndexedDB with fictional fixtures…");
    const storage = await server.ssrLoadModule("/src/db/index.ts");
    PaceDatabase = storage.PaceDatabase;
    const vault = await server.ssrLoadModule("/src/domain/vault.ts");
    const backup = await server.ssrLoadModule("/src/domain/backup/index.ts");
    const models = await server.ssrLoadModule("/src/types/index.ts");
    const makeDatabase = () => {
      const instance = new PaceDatabase(
        `pace-privacy-audit-${crypto.randomUUID()}`,
      );
      databases.push(instance);
      return instance;
    };
    const instance = makeDatabase();
    const rows = fixture(storage.defaultSettings, storage.defaultCategories);
    await instance.transaction("rw", instance.tables, async () => {
      for (const [table, values] of Object.entries(rows))
        await instance.table(table).bulkPut(values);
    });
    assert.equal((await vault.getVaultStatus(instance)).enabled, false);
    await assert.rejects(
      instance.providerCredentials.put({ id: "secret", value: token }),
      /暗号化/,
    );
    await vault.initializeVault(phrase, instance);
    for (const [table, values] of Object.entries(rows))
      sameRecords(await instance.table(table).toArray(), values);
    record(
      "Atomic legacy migration decrypts every seeded financial record and draft unchanged",
    );

    await instance.providerCredentials.put({
      id: "moneytree:default",
      value: JSON.stringify({
        accessToken: token,
        refreshToken: `${token}-REFRESH`,
        pending: { verifier: `${marker}PKCE-VERIFIER` },
      }),
    });
    const counts = {};
    for (const table of instance.tables) {
      const raw = await rawRows(instance, table.name);
      assert.ok(raw.length > 0, `Missing privacy fixture for ${table.name}`);
      counts[table.name] = raw.length;
      const persistent = JSON.stringify(raw);
      for (const privateValue of [
        marker,
        phrase,
        token,
        imageBase64,
        "2026-10-03",
        "ext-bank",
      ])
        assert.ok(
          !persistent.includes(privateValue),
          `Plain value detected in ${table.name}`,
        );
      if (table.name !== "vaultMeta") {
        for (const row of raw) {
          assert.equal(row.__paceVault, 1);
          assert.equal(Buffer.from(row.__iv, "base64").length, 12);
          assert.ok(
            typeof row.__ciphertext === "string" &&
              row.__ciphertext.length > 20,
          );
          const expectedFields = new Set([
            "__paceVault",
            "__iv",
            "__ciphertext",
          ]);
          for (const index of [table.schema.primKey, ...table.schema.indexes])
            for (const key of Array.isArray(index.keyPath)
              ? index.keyPath
              : [index.keyPath])
              if (key) expectedFields.add(key);
          for (const [key, value] of Object.entries(row)) {
            assert.ok(
              expectedFields.has(key),
              `Unencrypted payload field in ${table.name}`,
            );
            if (!key.startsWith("__"))
              assert.match(value, /^[A-Za-z0-9+/]{43}=$/);
          }
        }
      } else
        assert.deepEqual(
          Object.keys(raw[0]).sort(),
          [
            "id",
            "format",
            "version",
            "kdf",
            "iterations",
            "salt",
            "checkIv",
            "checkCiphertext",
          ].sort(),
        );
    }
    record(
      "Native IndexedDB inspection: every non-metadata store is encrypted; every persisted index is blinded",
      { tableCounts: counts },
    );

    const firstReceipt = (await rawRows(instance, "receipts"))[0];
    await instance.receipts.put(rows.receipts[0]);
    const secondReceipt = (await rawRows(instance, "receipts"))[0];
    assert.notEqual(firstReceipt.__iv, secondReceipt.__iv);
    assert.notEqual(firstReceipt.__ciphertext, secondReceipt.__ciphertext);
    const other = new PaceDatabase(instance.name);
    databases.push(other);
    await other.open();
    await assert.rejects(other.expenses.put(rows.expenses[0]), /パスフレーズ/);
    vault.lockVault(instance);
    assert.equal(instance.vaultSession.keys, null);
    assert.equal(instance.vaultSession.hashes.size, 0);
    await assert.rejects(instance.expenses.toArray(), /パスフレーズ/);
    await assert.rejects(
      vault.unlockVault("incorrect audit phrase", instance),
      /開けません/,
    );
    await vault.unlockVault(phrase, instance);
    sameRecords(await instance.expenses.toArray(), rows.expenses);
    record(
      "Fresh IVs, locked-tab rejection, key disposal and wrong-passphrase preservation",
    );

    const data = Object.fromEntries(
      Object.entries(rows)
        .filter(([name]) => name !== "drafts")
        .map(([name, values]) => [
          name,
          name === "settings" ? values[0] : values,
        ]),
    );
    const plainBackup = backup.createBackup(data);
    assert.equal(JSON.parse(plainBackup).schemaVersion, models.SCHEMA_VERSION);
    assert.ok(!plainBackup.includes(token));
    assert.ok(!plainBackup.includes("providerCredentials"));
    const restored = await backup.parseBackup(plainBackup);
    assert.deepEqual(
      restored,
      JSON.parse(JSON.stringify(backup.validateData(data))),
    );
    const encrypted = await backup.encryptBackup(data, phrase);
    assert.ok(!encrypted.includes(marker));
    assert.ok(!encrypted.includes(imageBase64));
    assert.deepEqual(await backup.parseBackup(encrypted, phrase), restored);
    await assert.rejects(
      backup.parseBackup(encrypted, "incorrect backup password"),
      /復号できません/,
    );
    const legacy = {
      ...data,
      expenses: [],
      incomes: [],
      cards: [],
      cardPayments: [],
      debts: [],
      repayments: [],
      recurringExpenses: [],
      recurringOccurrences: [],
      savingsGoals: [],
      savingsContributions: [],
      budgets: [],
      merchantRules: [],
      favorites: [],
    };
    for (const key of [
      "accounts",
      "transfers",
      "financialConnections",
      "externalTransactions",
      "syncStates",
      "receipts",
      "salaryRules",
      "financialAudits",
      "accountAdjustments",
    ])
      delete legacy[key];
    delete legacy.settings.financialAutomationEnabled;
    const legacyEnvelope = JSON.parse(backup.createBackup(legacy));
    legacyEnvelope.schemaVersion = 1;
    legacyEnvelope.metadata.schemaVersion = 1;
    await backup.parseBackup(JSON.stringify(legacyEnvelope));
    record(
      "Schema 1 compatibility, schema 2 round trip and encrypted export; provider credentials excluded",
    );

    const failing = makeDatabase();
    await failing.settings.put(structuredClone(storage.defaultSettings));
    await failing.expenses.put({
      ...rows.expenses[0],
      receiptId: undefined,
      recurringOccurrenceId: undefined,
    });
    const original = await rawRows(failing, "expenses");
    const encrypt = crypto.subtle.encrypt;
    let encryptedWrites = 0;
    crypto.subtle.encrypt = function (...args) {
      encryptedWrites++;
      if (encryptedWrites > 1)
        return Promise.reject(new Error("Simulated encryption failure"));
      return encrypt.apply(this, args);
    };
    try {
      await assert.rejects(vault.initializeVault(phrase, failing));
    } finally {
      crypto.subtle.encrypt = encrypt;
    }
    sameRecords(await rawRows(failing, "expenses"), original);
    sameRecords(await rawRows(failing, "settings"), [storage.defaultSettings]);
    assert.deepEqual(await vault.getVaultStatus(failing), {
      enabled: false,
      unlocked: false,
    });
    record(
      "Injected migration failure leaves all legacy records intact and the vault disabled",
    );

    const { MockFinancialProvider } = await server.ssrLoadModule(
      "/src/providers/mock/index.ts",
    );
    const mock = new MockFinancialProvider({
      accounts: [],
      transactions: [],
      updatedAt: null,
    });
    await mock.connect();
    await mock.getAccounts();
    await mock.getBalances();
    await mock.getTransactions();
    await mock.refresh();
    await mock.revokeAuthorization();
    const { MoneytreeProvider } = await server.ssrLoadModule(
      "/src/providers/moneytree/index.ts",
    );
    const unavailable = new MoneytreeProvider({
      config: null,
      store: {
        async read() {
          return null;
        },
        async write() {
          fail("Unconfigured provider attempted to persist a credential");
        },
        async delete() {},
      },
    });
    assert.equal(unavailable.isConfigured(), false);
    await assert.rejects(
      unavailable.connect(),
      (error) => error.code === "configurationRequired",
    );
    await assert.rejects(unavailable.getAccounts(), (error) =>
      ["configurationRequired", "notConnected"].includes(error.code),
    );
    assert.equal(networkCalls, 0);
    record(
      "Mock/manual and unconfigured Moneytree adapters perform zero network requests or credential writes",
      { networkRequests: networkCalls },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const database of databases) database.close();
    if (PaceDatabase)
      for (const name of new Set(databases.map((database) => database.name)))
        await PaceDatabase.delete(name);
    await server.close();
  }
}

try {
  await auditSources();
  await auditDisposableStorage();
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results/privacy-audit.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        passed: true,
        checks,
        scope:
          "Runtime source review and disposable fake IndexedDB with fictional fixtures; not a penetration test or device-storage recovery guarantee.",
      },
      null,
      2,
    ),
  );
  console.log(
    `Privacy audit passed: ${checks.length} checks. No real data, credentials or external network were used.`,
  );
} catch (error) {
  // Never print a data-bearing thrown object, stack or network response.
  console.error(
    "Privacy audit failed. A source policy or disposable-storage assertion did not pass.",
  );
  console.error(
    error instanceof assert.AssertionError
      ? error.message.split("\n")[0]
      : String(error?.message ?? "Unknown audit failure"),
  );
  process.exitCode = 1;
}
