import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  getLockConfig,
  setPin,
  verifyPin,
  disableLock,
  isDeviceAuthAvailable,
  checkDeviceAuthSupport,
  registerDeviceAuth,
  registerPasskey,
  isPasskeyRegistered,
  derToRawSignature,
  verifyDeviceAuth,
} from "../domain/security";

const items = new Map<string, string>();
beforeEach(() => {
  items.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local PIN screen lock", () => {
  it("hashes six-digit PIN with random salt and verifies without retaining plaintext", async () => {
    expect(getLockConfig().kind).toBe("none");
    await expect(setPin("12345")).rejects.toThrow("6桁");
    await expect(setPin("abcdef")).rejects.toThrow("6桁");
    await setPin("135790");
    const first = getLockConfig();
    expect(first.kind).toBe("pin");
    expect([...items.values()].join()).not.toContain("135790");
    expect(await verifyPin("135790")).toBe(true);
    expect(await verifyPin("000000")).toBe(false);
    await setPin("135790");
    const second = getLockConfig();
    if (first.kind === "pin" && second.kind === "pin") {
      expect(first.salt).not.toEqual(second.salt);
      expect(first.hash).not.toEqual(second.hash);
    }
    disableLock();
    expect(getLockConfig().kind).toBe("none");
  });
  it("persists cooldown after five failures and resets attempts on successful verification", async () => {
    await setPin("246810");
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    for (let count = 0; count < 5; count++)
      expect(await verifyPin("000000")).toBe(false);
    await expect(verifyPin("246810")).rejects.toThrow("秒後");
    const config = getLockConfig();
    expect(config).toMatchObject({
      failedAttempts: 5,
      lockedUntil: start + 30_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(start + 30_001);
    expect(await verifyPin("246810")).toBe(true);
    expect(getLockConfig()).toMatchObject({
      failedAttempts: 0,
      lockedUntil: 0,
    });
  });
  it("fails closed when the stored lock is corrupt", () => {
    items.set("pace:local-lock:v1", "{broken");
    expect(() => getLockConfig()).toThrow("ロック設定");
  });
  it("returns unavailable on environments without WebAuthn", async () => {
    vi.stubGlobal("isSecureContext", false);
    expect(await isDeviceAuthAvailable()).toBe(false);
  });
});

describe("authenticator signature conversion", () => {
  it("decodes DER positive integers with sign padding into fixed-width r||s", () => {
    const r = new Uint8Array(33);
    r.fill(0x82, 1);
    r[0] = 0;
    const s = new Uint8Array(32).fill(0x12);
    const der = new Uint8Array(71);
    der.set([0x30, 69, 0x02, 33]);
    der.set(r, 4);
    der.set([0x02, 32], 37);
    der.set(s, 39);
    const raw = derToRawSignature(der);
    expect(raw.length).toBe(64);
    expect([...raw.slice(0, 32)]).toEqual(Array<number>(32).fill(0x82));
    expect([...raw.slice(32)]).toEqual([...s]);
  });
  it("rejects malformed, negative and noncanonical ASN.1 integers", () => {
    expect(() =>
      derToRawSignature(new Uint8Array([0x30, 6, 2, 1, 0xff, 2, 1, 1])),
    ).toThrow();
    expect(() =>
      derToRawSignature(new Uint8Array([0x30, 7, 2, 2, 0, 1, 2, 1, 1])),
    ).toThrow();
    expect(() => derToRawSignature(new Uint8Array(64))).toThrow();
  });
});

describe("platform authentication support diagnostics", () => {
  function browser(probe: () => Promise<boolean> = async () => true) {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", {
      hostname: "pace.example",
      origin: "https://pace.example",
    });
    vi.stubGlobal("PublicKeyCredential", {
      isUserVerifyingPlatformAuthenticatorAvailable: probe,
    });
    const credentials = { create: vi.fn(), get: vi.fn() };
    vi.stubGlobal("navigator", {
      credentials,
      // The answer must depend on APIs, even when a browser cannot be identified.
      get userAgent(): never {
        throw new Error("User-agent sniffing must not be used");
      },
    });
    return credentials;
  }
  it("recognizes an available authenticator without reading Chrome or Samsung user-agent strings", async () => {
    const credentials = browser();
    expect(await checkDeviceAuthSupport()).toBe("available");
    expect(await isDeviceAuthAvailable()).toBe(true);
    expect(credentials.create).not.toHaveBeenCalled();
    expect(credentials.get).not.toHaveBeenCalled();
  });
  it("distinguishes insecure contexts from invalid RP domains", async () => {
    browser();
    vi.stubGlobal("isSecureContext", false);
    expect(await checkDeviceAuthSupport()).toBe("insecure-context");
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { hostname: "192.168.1.12" });
    expect(await checkDeviceAuthSupport()).toBe("invalid-domain");
    vi.stubGlobal("location", { hostname: "[::1]" });
    expect(await checkDeviceAuthSupport()).toBe("invalid-domain");
    vi.stubGlobal("location", undefined);
    expect(await checkDeviceAuthSupport()).toBe("insecure-context");
  });
  it.each([
    "public-key",
    "availability-method",
    "navigator",
    "create",
    "get",
  ] as const)(
    "reports an unsupported browser when %s is missing regardless of its user-agent",
    async (missing) => {
      browser();
      if (missing === "public-key")
        vi.stubGlobal("PublicKeyCredential", undefined);
      if (missing === "availability-method")
        vi.stubGlobal("PublicKeyCredential", {});
      if (missing === "navigator") vi.stubGlobal("navigator", undefined);
      if (missing === "create" || missing === "get")
        vi.stubGlobal("navigator", {
          userAgent: "SamsungBrowser/27.0 Chrome/123.0 Mobile",
          credentials: {
            create: missing === "create" ? undefined : vi.fn(),
            get: missing === "get" ? undefined : vi.fn(),
          },
        });
      expect(await checkDeviceAuthSupport()).toBe("unsupported-browser");
      expect(await isDeviceAuthAvailable()).toBe(false);
    },
  );
  it("distinguishes an unavailable device setup from a failed browser probe", async () => {
    browser(async () => false);
    expect(await checkDeviceAuthSupport()).toBe("not-configured");
    browser(async () => {
      throw new DOMException("Probe denied", "NotAllowedError");
    });
    expect(await checkDeviceAuthSupport()).toBe("check-failed");
    expect(await isDeviceAuthAvailable()).toBe(false);
  });
});

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function rawToDer(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const encodePart = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const part = bytes.slice(start);
    if (!(part[0] & 0x80)) return part;
    const result = new Uint8Array(part.length + 1);
    result.set(part, 1);
    return result;
  };
  const r = encodePart(value.slice(0, 32));
  const s = encodePart(value.slice(32));
  const result = new Uint8Array(6 + r.length + s.length);
  result.set([0x30, result.length - 2, 0x02, r.length]);
  result.set(r, 4);
  result.set([0x02, s.length], 4 + r.length);
  result.set(s, 6 + r.length);
  return result;
}

/**
 * An Android-style platform credential: real P-256 keys, a standards-shaped CBOR
 * attestation and fresh signed challenges. Only the browser transport is simulated;
 * public-key extraction, hashing, DER conversion and signature verification are real.
 */
async function enrollingAuthenticator(
  options: {
    assertionFlags?: number;
    signCount?: number;
    registrationFlags?: number;
    residentKey?: boolean;
  } = {},
) {
  const flags = options.assertionFlags ?? 0x05;
  const signCount = options.signCount ?? 0;
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialId = new Uint8Array([91, 34, 177, 8]);
  const fromBase64url = (text: string): Uint8Array =>
    Uint8Array.from(
      atob(
        text
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .padEnd(Math.ceil(text.length / 4) * 4, "="),
      ),
      (char) => char.charCodeAt(0),
    );
  if (!jwk.x || !jwk.y) throw new Error("P-256 coordinates missing");
  // COSE_Key {1: 2, 3: -7, -1: 1, -2: x, -3: y}, encoded independently of the reader.
  const cose = new Uint8Array([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...fromBase64url(jwk.x),
    0x22,
    0x58,
    0x20,
    ...fromBase64url(jwk.y),
  ]);
  const encoder = new TextEncoder();
  const rpHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode("pace.example")),
  );
  const authData = (value: number): Uint8Array<ArrayBuffer> => {
    const data = new Uint8Array(37);
    data.set(rpHash);
    data[32] = value;
    new DataView(data.buffer).setUint32(33, signCount, false);
    return data;
  };
  const clientData = (
    challenge: BufferSource,
    type: string,
  ): Uint8Array<ArrayBuffer> => {
    if (!(challenge instanceof Uint8Array))
      throw new Error("Expected generated challenge bytes");
    return encoder.encode(
      JSON.stringify({
        type,
        challenge: base64url(challenge),
        origin: "https://pace.example",
        crossOrigin: false,
      }),
    );
  };
  class Attestation {
    clientDataJSON = new ArrayBuffer(0);
    attestationObject = new ArrayBuffer(0);
  }
  class Assertion {
    clientDataJSON = new ArrayBuffer(0);
    authenticatorData = new ArrayBuffer(0);
    signature = new ArrayBuffer(0);
  }
  class Credential {
    static async isUserVerifyingPlatformAuthenticatorAvailable() {
      return true;
    }
    rawId = credentialId.buffer;
    getClientExtensionResults() {
      return options.residentKey === undefined
        ? {}
        : { credProps: { rk: options.residentKey } };
    }
    constructor(public response: Attestation | Assertion) {}
  }
  let creation: PublicKeyCredentialCreationOptions | undefined;
  const challenges: string[] = [];
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", {
    hostname: "pace.example",
    origin: "https://pace.example",
  });
  vi.stubGlobal("PublicKeyCredential", Credential);
  vi.stubGlobal("AuthenticatorAttestationResponse", Attestation);
  vi.stubGlobal("AuthenticatorAssertionResponse", Assertion);
  vi.stubGlobal("navigator", {
    credentials: {
      create: async (request: CredentialCreationOptions) => {
        creation = request.publicKey;
        if (!creation) throw new Error("Public key creation options missing");
        const prefix = authData(options.registrationFlags ?? flags | 0x40);
        const registrationData = new Uint8Array(
          55 + credentialId.length + cose.length,
        );
        registrationData.set(prefix); // AAGUID remains 16 zero bytes for this fixture.
        new DataView(registrationData.buffer).setUint16(
          53,
          credentialId.length,
          false,
        );
        registrationData.set(credentialId, 55);
        registrationData.set(cose, 55 + credentialId.length);
        // {fmt: "none", attStmt: {}, authData: <bytes>}; short keys and one-byte length.
        const cbor = new Uint8Array([
          0xa3,
          0x63,
          ...encoder.encode("fmt"),
          0x64,
          ...encoder.encode("none"),
          0x67,
          ...encoder.encode("attStmt"),
          0xa0,
          0x68,
          ...encoder.encode("authData"),
          0x58,
          registrationData.length,
          ...registrationData,
        ]);
        const response = new Attestation();
        response.clientDataJSON = clientData(
          creation.challenge,
          "webauthn.create",
        ).buffer;
        response.attestationObject = cbor.buffer;
        return new Credential(response);
      },
      get: async (request: CredentialRequestOptions) => {
        const publicKey = request.publicKey;
        if (!publicKey) throw new Error("Public key request missing");
        expect(publicKey.userVerification).toBe("required");
        expect(publicKey.rpId).toBe("pace.example");
        expect(publicKey.allowCredentials?.[0].id).toEqual(credentialId);
        const client = clientData(publicKey.challenge, "webauthn.get");
        const clientHash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", client),
        );
        const authenticationData = authData(flags);
        const signed = new Uint8Array(69);
        signed.set(authenticationData);
        signed.set(clientHash, 37);
        const signature = new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keys.privateKey,
            signed,
          ),
        );
        challenges.push(new TextDecoder().decode(client));
        const response = new Assertion();
        response.clientDataJSON = client.buffer;
        response.authenticatorData = authenticationData.buffer;
        response.signature = rawToDer(signature).buffer;
        return new Credential(response);
      },
    },
  });
  return { jwk, credentialId, getCreation: () => creation, challenges };
}

describe("platform credential enrollment and Android-style assertions", () => {
  it("requires a discoverable passkey with user verification and verifies it with the existing trusted-key flow", async () => {
    const authenticator = await enrollingAuthenticator({
      residentKey: true,
      assertionFlags: 0x1d,
    });
    await registerPasskey();
    expect(authenticator.getCreation()).toMatchObject({
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      extensions: { credProps: true },
    });
    expect(isPasskeyRegistered()).toBe(true);
    const config = getLockConfig();
    expect(config.kind).toBe("device");
    expect(Object.keys(config).sort()).toEqual(
      [
        "kind",
        "credentialId",
        "publicKey",
        "rpId",
        "origin",
        "signCount",
      ].sort(),
    );
    expect(await verifyDeviceAuth()).toBe(true);
    expect(await verifyDeviceAuth()).toBe(true);
    // A lost display label must not change the trusted key or block authentication.
    items.delete("pace:passkey-label:v1");
    expect(isPasskeyRegistered()).toBe(false);
    expect(getLockConfig()).toEqual(config);
    expect(await verifyDeviceAuth()).toBe(true);
  });
  it("accepts an omitted optional credProps response while still requiring a resident key", async () => {
    const authenticator = await enrollingAuthenticator();
    await registerPasskey();
    expect(
      authenticator.getCreation()?.authenticatorSelection?.residentKey,
    ).toBe("required");
    expect(isPasskeyRegistered()).toBe(true);
  });
  it("rejects an explicit nonresident result without replacing the existing PIN", async () => {
    await setPin("135790");
    const original = getLockConfig();
    await enrollingAuthenticator({ residentKey: false });
    await expect(registerPasskey()).rejects.toThrow("パスキーを保存できません");
    expect(getLockConfig()).toEqual(original);
    expect(isPasskeyRegistered()).toBe(false);
    expect(await verifyPin("135790")).toBe(true);
  });
  it("preserves an existing device credential on canceled passkey registration", async () => {
    await enrollingAuthenticator();
    await registerDeviceAuth();
    const original = getLockConfig();
    vi.spyOn(navigator.credentials, "create").mockRejectedValue(
      new DOMException("Canceled", "NotAllowedError"),
    );
    await expect(registerPasskey()).rejects.toThrow("変更していません");
    expect(getLockConfig()).toEqual(original);
    expect(await verifyDeviceAuth()).toBe(true);
  });
  it("rejects a passkey without user verification and keeps the former passkey label and lock", async () => {
    await enrollingAuthenticator({ residentKey: true });
    await registerPasskey();
    const original = new Map(items);
    await enrollingAuthenticator({
      residentKey: true,
      registrationFlags: 0x41,
    });
    await expect(registerPasskey()).rejects.toThrow("本人確認");
    expect(items).toEqual(original);
  });
  it("clears only the display label when replacing a passkey with PIN, legacy device auth or no lock", async () => {
    await enrollingAuthenticator({ residentKey: true });
    await registerPasskey();
    await setPin("135790");
    expect(isPasskeyRegistered()).toBe(false);
    expect(await verifyPin("135790")).toBe(true);
    await registerPasskey();
    await registerDeviceAuth();
    expect(isPasskeyRegistered()).toBe(false);
    expect(await verifyDeviceAuth()).toBe(true);
    await registerPasskey();
    disableLock();
    expect(isPasskeyRegistered()).toBe(false);
    expect(getLockConfig().kind).toBe("none");
  });
  it("enrolls the real CBOR public key using platform UV-required ES256 and verifies repeated zero-counter assertions", async () => {
    const authenticator = await enrollingAuthenticator();
    await registerDeviceAuth();
    expect(authenticator.getCreation()).toMatchObject({
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      attestation: "none",
    });
    expect(getLockConfig()).toMatchObject({
      kind: "device",
      credentialId: base64url(authenticator.credentialId),
      publicKey: { x: authenticator.jwk.x, y: authenticator.jwk.y },
      signCount: 0,
    });
    expect(await verifyDeviceAuth()).toBe(true);
    expect(await verifyDeviceAuth()).toBe(true);
    expect(new Set(authenticator.challenges).size).toBe(2);
    expect(getLockConfig()).toMatchObject({ signCount: 0 });
  });
  it.each([0x0d, 0x1d])(
    "accepts consecutive signed assertions with backup flags %i without requiring a monotonic counter",
    async (assertionFlags) => {
      await enrollingAuthenticator({ assertionFlags, signCount: 7 });
      await registerDeviceAuth();
      expect(await verifyDeviceAuth()).toBe(true);
      expect(await verifyDeviceAuth()).toBe(true);
      expect(getLockConfig()).toMatchObject({ signCount: 7 });
    },
  );
  it("rejects a registration without actual user verification and preserves an existing PIN", async () => {
    await setPin("135790");
    const original = getLockConfig();
    await enrollingAuthenticator({ registrationFlags: 0x41 }); // UP + AT, no UV.
    await expect(registerDeviceAuth()).rejects.toThrow("本人確認");
    expect(getLockConfig()).toEqual(original);
  });
});

describe("locally verified WebAuthn assertions", () => {
  async function virtualAuthenticator(
    mode:
      "valid" | "missingUV" | "wrongOrigin" | "badSignature" | "wrongChallenge",
  ) {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const credentialId = new Uint8Array([1, 2, 3, 4]);
    items.set(
      "pace:local-lock:v1",
      JSON.stringify({
        kind: "device",
        credentialId: base64url(credentialId),
        publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
        rpId: "pace.example",
        origin: "https://pace.example",
        signCount: 0,
      }),
    );
    class Assertion {
      clientDataJSON = new ArrayBuffer(0);
      authenticatorData = new ArrayBuffer(0);
      signature = new ArrayBuffer(0);
    }
    class Credential {
      rawId = credentialId.buffer;
      response = new Assertion();
    }
    vi.stubGlobal("location", {
      hostname: "pace.example",
      origin: "https://pace.example",
    });
    vi.stubGlobal("PublicKeyCredential", Credential);
    vi.stubGlobal("AuthenticatorAssertionResponse", Assertion);
    vi.stubGlobal("navigator", {
      credentials: {
        get: async (options: CredentialRequestOptions) => {
          expect(options.publicKey?.userVerification).toBe("required");
          const challenge = options.publicKey?.challenge;
          if (!(challenge instanceof Uint8Array))
            throw new Error("missing challenge");
          const client = new TextEncoder().encode(
            JSON.stringify({
              type: "webauthn.get",
              challenge:
                mode === "wrongChallenge"
                  ? base64url(new Uint8Array(32))
                  : base64url(challenge),
              origin:
                mode === "wrongOrigin"
                  ? "https://attacker.example"
                  : "https://pace.example",
              crossOrigin: false,
            }),
          );
          const authData = new Uint8Array(37);
          authData.set(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode("pace.example"),
              ),
            ),
          );
          authData[32] = mode === "missingUV" ? 0x01 : 0x05;
          authData[36] = 1;
          const signed = new Uint8Array(69);
          signed.set(authData);
          signed.set(
            new Uint8Array(await crypto.subtle.digest("SHA-256", client)),
            37,
          );
          const signature = new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              keys.privateKey,
              signed,
            ),
          );
          if (mode === "badSignature") signature[0] ^= 0x01;
          const credential = new Credential();
          credential.response.clientDataJSON = client.buffer;
          credential.response.authenticatorData = authData.buffer;
          credential.response.signature = rawToDer(signature).buffer;
          return credential;
        },
      },
    });
  }
  it("cryptographically verifies a signed assertion including challenge, origin and user verification", async () => {
    await virtualAuthenticator("valid");
    expect(await verifyDeviceAuth()).toBe(true);
    expect(getLockConfig()).toMatchObject({ signCount: 1 });
    // Reused nonzero counters for a non-backup credential are rejected.
    expect(await verifyDeviceAuth()).toBe(false);
  });
  it("rejects a signature that does not match the stored public key", async () => {
    await virtualAuthenticator("badSignature");
    expect(await verifyDeviceAuth()).toBe(false);
  });
  it.each(["missingUV", "wrongOrigin", "wrongChallenge"] as const)(
    "rejects %s assertions even with a cryptographically valid signature",
    async (mode) => {
      await virtualAuthenticator(mode);
      await expect(verifyDeviceAuth()).rejects.toThrow("デバイス認証");
    },
  );
});
