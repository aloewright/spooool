import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../apps/web/src/lib/keyring";

describe("keyring", () => {
  it("roundtrips a secret through encrypt/decrypt", async () => {
    const master = "test-master-key-32-bytes-long-pad";
    const { ciphertext, iv } = await encryptSecret("my-api-key", master);
    const plaintext = await decryptSecret(ciphertext, iv, master);
    expect(plaintext).toBe("my-api-key");
  });

  it("produces distinct ciphertext on each call", async () => {
    const master = "test-master-key-32-bytes-long-pad";
    const a = await encryptSecret("same-secret", master);
    const b = await encryptSecret("same-secret", master);
    expect(Buffer.from(a.iv).toString("hex")).not.toBe(Buffer.from(b.iv).toString("hex"));
  });

  it("fails to decrypt with a wrong master key", async () => {
    const { ciphertext, iv } = await encryptSecret("secret", "correct-master-key");
    await expect(decryptSecret(ciphertext, iv, "wrong-master-key")).rejects.toThrow();
  });

  it("accepts ArrayBuffer inputs to decryptSecret", async () => {
    const master = "test-master-key-32-bytes-long-pad";
    const { ciphertext, iv } = await encryptSecret("buffer-input-secret", master);
    const asBuffer = (arr: Uint8Array) =>
      arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
    const plaintext = await decryptSecret(asBuffer(ciphertext), asBuffer(iv), master);
    expect(plaintext).toBe("buffer-input-secret");
  });
});
