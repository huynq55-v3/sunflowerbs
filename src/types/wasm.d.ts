// Khai báo module WASM (wasm-pack --target web) để TS typecheck không lỗi
// trước khi chạy `npm run crypto:build` (lúc đó rust-crypto/pkg chưa tồn tại).
declare module "@crypto/sunflower_crypto.js" {
  export default function init(input?: WebAssembly.Module | BufferSource | Response): Promise<unknown>;
  export function kdf_argon2id(input: Uint8Array, salt: Uint8Array, mem_kib: number, iters: number): Uint8Array;
  export function kdf_hkdf_expand(master_key: Uint8Array, info: Uint8Array): Uint8Array;
  export function aead_encrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array;
  export function aead_decrypt(key: Uint8Array, ciphertext_blob: Uint8Array): Uint8Array;
  export function ed25519_generate_keypair(): { privateKey: Uint8Array; publicKey: Uint8Array };
  export function ed25519_sign(private_key: Uint8Array, message: Uint8Array): Uint8Array;
  export function ed25519_verify(public_key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
  export function ed25519_pub_to_x25519(ed_public: Uint8Array): Uint8Array;
  export function ed25519_priv_to_x25519(ed_private: Uint8Array): Uint8Array;
  export function x25519_diffie_hellman(my_private: Uint8Array, their_public: Uint8Array): Uint8Array;
}
