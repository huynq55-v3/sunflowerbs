//! Loader cho Rust WASM crypto engine (`sunflower-crypto`).
//!
//! Build một lần: `npm run crypto:build` → tạo `rust-crypto/pkg` (ES module).
//! Module này dùng dynamic import + singleton để:
//!   1. Tự khởi tạo WASM đúng một lần.
//!   2. Che giấu location thật của bundle (qua alias `@crypto`).
//!   3. Cung cấp TypeScript type an toàn cho toàn bộ API mật mã.

/** Cặp khóa Ed25519 trả về từ WASM. */
export interface WasmKeyPair {
  /** Private key / seed 32 bytes — mã hóa và lưu trong vault. */
  privateKey: Uint8Array;
  /** Public key 32 bytes — công khai. */
  publicKey: Uint8Array;
}

/** Mặt nạ giao diện mà module WASM (wasm-pack --target web) export. */
export interface WasmCrypto {
  // ── KDF ──
  /** Argon2id: byte input + salt → khóa 32 bytes. */
  kdf_argon2id(input: Uint8Array, salt: Uint8Array, mem_kib: number, iters: number): Uint8Array;
  /** HKDF (SHA-256): khóa mẹ + info → khóa con 32 bytes. */
  kdf_hkdf_expand(master_key: Uint8Array, info: Uint8Array): Uint8Array;
  // ── AEAD ──
  /** ChaCha20-Poly1305 mã hóa → [nonce(12) || ciphertext]. */
  aead_encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** ChaCha20-Poly1305 giải mã. Ném lỗi nếu sai khóa/dữ liệu hỏng. */
  aead_decrypt(key: Uint8Array, ciphertext_blob: Uint8Array): Uint8Array;
  // ── Ed25519 ──
  /** Sinh cặp khóa Ed25519 ngẫu nhiên. */
  ed25519_generate_keypair(): WasmKeyPair;
  /** Ký số → chữ ký 64 bytes. */
  ed25519_sign(private_key: Uint8Array, message: Uint8Array): Uint8Array;
  /** Xác thực chữ ký. */
  ed25519_verify(public_key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
  // ── X25519 ──
  /** Ed25519 public key → X25519 public key. */
  ed25519_pub_to_x25519(ed_public: Uint8Array): Uint8Array;
  /** Ed25519 private key (seed) → X25519 private key (SHA512(seed)[0..32]). */
  ed25519_priv_to_x25519(ed_private: Uint8Array): Uint8Array;
  /** X25519 Diffie-Hellman → shared secret 32 bytes. */
  x25519_diffie_hellman(my_private: Uint8Array, their_public: Uint8Array): Uint8Array;
}

let instance: WasmCrypto | null = null;

/**
 * Lazy-load WASM một lần rồi cache. Gọi trong mọi luồng mật mã.
 * @throws Error nếu chưa chạy `npm run crypto:build`.
 */
export async function getCrypto(): Promise<WasmCrypto> {
  if (instance) return instance;

  // wasm-pack --target web export default init(). Import qua alias @crypto.
  const mod = (await import("@crypto/sunflower_crypto.js")) as unknown as {
    default: () => Promise<void>;
  } & WasmCrypto;

  await mod.default(); // init WASM binary
  instance = mod as WasmCrypto;
  return instance;
}

/** Tiện ích: encode Uint8Array → chuỗi base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Tiện ích: decode base64 → Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url (an toàn cho URL/hash fragment) — không có + / = */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → Uint8Array. */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + pad);
}
