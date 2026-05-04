import { describe, expect, test } from "bun:test";
import {
	isSensitiveKey,
	redactString,
	sanitizeForTelemetry,
	scanForSecrets,
	type RedactionConfig,
} from "../src/redaction";

const ON: RedactionConfig = { enabled: true };
const OFF: RedactionConfig = { enabled: false };
const NO_ENV: NodeJS.ProcessEnv = {};

function withSecrets(secrets: string[]): RedactionConfig {
	return { enabled: true, additionalSecrets: secrets };
}

// --- isSensitiveKey ---

describe("isSensitiveKey", () => {
	test("detects sensitive keys", () => {
		expect(isSensitiveKey("api_key")).toBe(true);
		expect(isSensitiveKey("API_KEY")).toBe(true);
		expect(isSensitiveKey("secret")).toBe(true);
		expect(isSensitiveKey("password")).toBe(true);
		expect(isSensitiveKey("AUTHORIZATION")).toBe(true);
		expect(isSensitiveKey("access_token")).toBe(true);
		expect(isSensitiveKey("client_secret")).toBe(true);
		expect(isSensitiveKey("private_key")).toBe(true);
		expect(isSensitiveKey("credential")).toBe(true);
		expect(isSensitiveKey("webhook_secret")).toBe(true);
	});

	test("excludes public keys", () => {
		expect(isSensitiveKey("public_key")).toBe(false);
		expect(isSensitiveKey("PUBLIC_KEY")).toBe(false);
	});

	test("excludes token-count keys", () => {
		expect(isSensitiveKey("total_tokens")).toBe(false);
		expect(isSensitiveKey("input_tokens")).toBe(false);
		expect(isSensitiveKey("output_tokens")).toBe(false);
		expect(isSensitiveKey("max_tokens")).toBe(false);
		expect(isSensitiveKey("prompt_tokens")).toBe(false);
		expect(isSensitiveKey("cache_tokens")).toBe(false);
		expect(isSensitiveKey("tokens")).toBe(false);
	});

	test("passes benign keys", () => {
		expect(isSensitiveKey("name")).toBe(false);
		expect(isSensitiveKey("description")).toBe(false);
		expect(isSensitiveKey("version")).toBe(false);
		expect(isSensitiveKey("url")).toBe(false);
	});
});

// --- redactString ---

describe("redactString", () => {
	test("returns input unchanged when disabled", () => {
		const input = "my password is hunter2";
		expect(redactString(OFF, input, NO_ENV)).toBe(input);
	});

	test("returns empty string unchanged", () => {
		expect(redactString(ON, "", NO_ENV)).toBe("");
	});

	test("redacts private keys", () => {
		const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const result = redactString(ON, key, NO_ENV);
		expect(result).toContain("[REDACTED:private-key:");
		expect(result).not.toContain("MIIEowIBAAKCAQEA");
	});

	test("redacts Bearer tokens", () => {
		const result = redactString(ON, "Authorization: Bearer abcdefghijklmnop123456", NO_ENV);
		expect(result).toContain("[REDACTED:bearer-token:");
		expect(result).not.toContain("abcdefghijklmnop123456");
	});

	test("redacts GitHub tokens", () => {
		const result = redactString(ON, "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", NO_ENV);
		expect(result).toContain("[REDACTED:github-token:");
		expect(result).not.toContain("ghp_");
	});

	test("redacts OpenAI keys", () => {
		const result = redactString(ON, "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123456789", NO_ENV);
		expect(result).toContain("[REDACTED:openai-key:");
	});

	test("redacts Anthropic keys", () => {
		const result = redactString(ON, "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij", NO_ENV);
		expect(result).toContain("[REDACTED:anthropic-key:");
	});

	test("redacts AWS access keys", () => {
		const result = redactString(ON, "key=AKIAIOSFODNN7EXAMPLE", NO_ENV);
		expect(result).toContain("[REDACTED:aws-access-key:");
	});

	test("redacts JWTs", () => {
		const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const result = redactString(ON, jwt, NO_ENV);
		expect(result).toContain("[REDACTED:jwt:");
	});

	test("redacts URL-embedded credentials", () => {
		const result = redactString(ON, "postgres://user:pass@db.example.com:5432/mydb", NO_ENV);
		expect(result).toContain("[REDACTED:url-embedded-credentials:");
		expect(result).not.toContain("user:pass@");
	});

	test("redacts email addresses", () => {
		const result = redactString(ON, "contact: admin@example.com", NO_ENV);
		expect(result).toContain("[REDACTED:email:");
		expect(result).not.toContain("admin@example.com");
	});

	test("redacts SSNs", () => {
		const result = redactString(ON, "SSN: 123-45-6789", NO_ENV);
		expect(result).toContain("[REDACTED:ssn:");
	});

	test("redacts valid credit card numbers", () => {
		// 4111 1111 1111 1111 passes Luhn
		const result = redactString(ON, "card: 4111 1111 1111 1111", NO_ENV);
		expect(result).toContain("[REDACTED:credit-card:");
	});

	test("does not redact invalid credit card patterns", () => {
		// 1234 1234 1234 1234 fails Luhn
		const result = redactString(ON, "number: 1234 1234 1234 1234", NO_ENV);
		expect(result).not.toContain("[REDACTED:credit-card:");
		expect(result).toContain("1234 1234 1234 1234");
	});

	test("redacts assignment patterns for sensitive keys", () => {
		const result = redactString(ON, 'API_KEY="my-super-secret-key-value"', NO_ENV);
		expect(result).toContain("[REDACTED:api_key:");
		expect(result).not.toContain("my-super-secret-key-value");
	});

	test("preserves non-sensitive assignments", () => {
		const input = 'PORT="3000"';
		expect(redactString(ON, input, NO_ENV)).toBe(input);
	});

	test("redacts additional secrets from config", () => {
		const config = withSecrets(["my-custom-secret-value"]);
		const result = redactString(config, "the value is my-custom-secret-value", NO_ENV);
		expect(result).toContain("[REDACTED:configured-secret:");
		expect(result).not.toContain("my-custom-secret-value");
	});

	test("redacts secrets from env vars with sensitive keys", () => {
		const env = { MY_API_KEY: "env-secret-value-12345" };
		const result = redactString(ON, "found env-secret-value-12345 here", env);
		expect(result).toContain("[REDACTED:my_api_key:");
		expect(result).not.toContain("env-secret-value-12345");
	});

	test("redacts data URLs", () => {
		const result = redactString(ON, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", NO_ENV);
		expect(result).toContain("[REDACTED:data-url:");
	});

	test("redacts long base64 blobs", () => {
		const blob = "A".repeat(200);
		const result = redactString(ON, blob, NO_ENV);
		expect(result).toContain("[REDACTED:long-base64-blob:");
	});

	test("redacts long hex blobs", () => {
		const hex = "a".repeat(128);
		const result = redactString(ON, hex, NO_ENV);
		expect(result).toContain("[REDACTED:long-hex-blob:");
	});

	test("preserves clean content", () => {
		const input = "Hello world, this is a normal message with no secrets.";
		expect(redactString(ON, input, NO_ENV)).toBe(input);
	});
});

// --- sanitizeForTelemetry ---

describe("sanitizeForTelemetry", () => {
	test("sanitizes strings inside nested objects", () => {
		const input = { config: { apiKey: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij" } };
		const result = sanitizeForTelemetry(ON, input, NO_ENV);
		expect(typeof result.config!.apiKey).toBe("string");
		expect((result.config!.apiKey as string)).toContain("[REDACTED:openai-key:");
	});

	test("sanitizes sensitive-keyed fields", () => {
		const input = { password: "hunter2", name: "Alice" };
		const result = sanitizeForTelemetry(ON, input, NO_ENV);
		expect(result.password).toContain("[REDACTED:");
		expect(result.name).toBe("Alice");
	});

	test("sanitizes arrays", () => {
		const input = [{ token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" }, { token: "clean" }];
		const result = sanitizeForTelemetry(ON, input, NO_ENV);
		expect((result as any[])[0].token).toContain("[REDACTED:");
		expect((result as any[])[1].token).toBe("clean");
	});

	test("handles circular references", () => {
		const obj: any = { name: "test" };
		obj.self = obj;
		const result = sanitizeForTelemetry(ON, obj, NO_ENV);
		expect(result.self).toBe("[Circular]");
	});

	test("handles null and undefined", () => {
		expect(sanitizeForTelemetry(ON, null, NO_ENV)).toBeNull();
		expect(sanitizeForTelemetry(ON, undefined, NO_ENV)).toBeUndefined();
	});

	test("handles functions", () => {
		const fn = function myFunc() {};
		expect(sanitizeForTelemetry(ON, fn, NO_ENV)).toBe("[function myFunc]");
	});

	test("handles Error objects", () => {
		const err = new Error("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij broke");
		const result = sanitizeForTelemetry(ON, err, NO_ENV);
		expect(result.message).toContain("[REDACTED:");
	});

	test("handles bigints", () => {
		expect(sanitizeForTelemetry(ON, BigInt(42), NO_ENV)).toBe("42");
	});

	test("handles binary-keyed fields with blob placeholder", () => {
		const input = { screenshot: "a very long binary string value here", name: "Bob" };
		const result = sanitizeForTelemetry(ON, input, NO_ENV);
		expect((result.screenshot as string)).toContain("[REDACTED:");
		expect((result.screenshot as string)).toContain("chars");
		expect(result.name).toBe("Bob");
	});

	test("returns primitives unchanged when disabled", () => {
		expect(sanitizeForTelemetry(OFF, "secret stuff", NO_ENV)).toBe("secret stuff");
		expect(sanitizeForTelemetry(OFF, 42, NO_ENV)).toBe(42);
		expect(sanitizeForTelemetry(OFF, true, NO_ENV)).toBe(true);
	});

	test("preserves booleans and numbers", () => {
		expect(sanitizeForTelemetry(ON, 42, NO_ENV)).toBe(42);
		expect(sanitizeForTelemetry(ON, true, NO_ENV)).toBe(true);
		expect(sanitizeForTelemetry(ON, false, NO_ENV)).toBe(false);
	});
});

// --- scanForSecrets ---

describe("scanForSecrets", () => {
	test("detects secrets and returns findings", () => {
		const input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
		const findings = scanForSecrets(ON, input, NO_ENV);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.some((f) => f.reason === "github-token")).toBe(true);
	});

	test("returns empty findings for clean content", () => {
		const findings = scanForSecrets(ON, "Hello world", NO_ENV);
		expect(findings).toEqual([]);
	});

	test("returns empty findings for empty input", () => {
		expect(scanForSecrets(ON, "", NO_ENV)).toEqual([]);
	});

	test("counts multiple occurrences", () => {
		const input = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij and sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA987654321zyxwvutsrqponm";
		const findings = scanForSecrets(ON, input, NO_ENV);
		const openai = findings.find((f) => f.reason === "openai-key");
		expect(openai).toBeDefined();
		expect(openai!.count).toBeGreaterThanOrEqual(2);
	});

	test("detects configured additional secrets", () => {
		const config = withSecrets(["my-special-secret-1234"]);
		const findings = scanForSecrets(config, "contains my-special-secret-1234", NO_ENV);
		expect(findings.some((f) => f.reason === "configured-secret")).toBe(true);
	});

	test("does not flag already-redacted content", () => {
		const input = "[REDACTED:secret:abc123def45]";
		expect(scanForSecrets(ON, input, NO_ENV)).toEqual([]);
	});
});
