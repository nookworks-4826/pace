// Run the shared WebAuthn flow with discoverable credentials and PIN migration.
process.env.PACE_QA_PASSKEY = "1";
await import("./qa-webauthn.mjs");
