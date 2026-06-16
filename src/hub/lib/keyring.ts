const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptSecret(secret: string, masterKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(masterKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(secret),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptSecret(
  ciphertext: ArrayBuffer | Uint8Array,
  iv: ArrayBuffer | Uint8Array,
  masterKey: string,
) {
  const key = await importKey(masterKey);
  const normalizedIv = new Uint8Array(toArrayBuffer(iv));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: normalizedIv },
    key,
    toArrayBuffer(ciphertext),
  );
  return decoder.decode(plaintext);
}

async function importKey(masterKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(masterKey));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
