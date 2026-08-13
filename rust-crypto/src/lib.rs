//! # sunflower-crypto — Generic Crypto Primitives for WASM
//!
//! Một thư viện **toán học thuần túy**, không chứa bất kỳ logic nghiệp vụ nào
//! (không biết Password / User / Folder / File / "AUTH_FAILED"...).
//!
//! Chỉ làm việc với đúng 4 nhóm nguyên thủy (cryptographic primitives):
//!
//! | Nhóm          | Hàm                               | Thuật toán                 |
//! |---------------|-----------------------------------|----------------------------|
//! | **KDF**       | `kdf_argon2id`                    | Argon2id → 32 bytes        |
//! |               | `kdf_hkdf_expand`                 | HKDF-SHA256 → 32 bytes     |
//! | **AEAD**      | `aead_encrypt` / `aead_decrypt`   | ChaCha20-Poly1305          |
//! | **Ed25519**   | `ed25519_generate_keypair`        | Sinh cặp khóa              |
//! |               | `ed25519_sign` / `ed25519_verify` | Ký / xác thực              |
//! | **X25519**    | `ed25519_pub_to_x25519`           | Edwards → Montgomery       |
//! |               | `x25519_diffie_hellman`           | DH → shared secret         |
//!
//! Mọi đầu vào/đầu ra đều là **mảng byte** (`Uint8Array`). Toàn bộ logic app
//! (validate mật khẩu, lắp ghép luồng đăng ký/đăng nhập...) nằm ở lớp
//! TypeScript/JavaScript bên ngoài. Nhờ vậy file `.wasm` này tái dùng được cho
//! bất kỳ dự án mã hóa nào (Wallet, Messenger, Cloud Storage, Notes...).
//!
//! # Kiến trúc
//! Lõi thuật toán nằm trong các hàm `*_bytes` thuần Rust (test được trên host);
//! các hàm `#[wasm_bindgen]` chỉ là lớp wrapper mỏng chuyển `Vec<u8>` ↔
//! `Uint8Array` cho trình duyệt.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use wasm_bindgen::prelude::*;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroize;

/// Độ dài khóa dùng xuyên suốt (Argon2id, AEAD, Ed25519, X25519 đều 32 bytes).
pub const KEY_LEN: usize = 32;
/// Nonce của ChaCha20-Poly1305.
pub const NONCE_LEN: usize = 12;

fn to_js(bytes: &[u8]) -> js_sys::Uint8Array {
    js_sys::Uint8Array::from(bytes)
}

fn js_err(e: String) -> JsError {
    JsError::new(&e)
}

// ════════════════════════════════════════════════════════════════════════════
// 1. KDF — sinh khóa từ byte input bất kỳ
// ════════════════════════════════════════════════════════════════════════════

/// Lõi Argon2id với tham số chỉ định (parallelism cố định 1).
pub fn argon2id_bytes(
    input: &[u8],
    salt: &[u8],
    mem_kib: u32,
    iters: u32,
) -> Result<[u8; KEY_LEN], String> {
    if salt.len() < 8 {
        return Err("salt must be at least 8 bytes".into());
    }
    let params = Params::new(mem_kib, iters, 1, Some(KEY_LEN))
        .map_err(|e| format!("invalid Argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon2
        .hash_password_into(input, salt, &mut out)
        .map_err(|e| format!("argon2id failed: {e}"))?;
    Ok(out)
}

/// Argon2id: biến bất kỳ byte input + salt thành khóa 32 bytes.
#[wasm_bindgen]
pub fn kdf_argon2id(
    input: &[u8],
    salt: &[u8],
    mem_kib: u32,
    iters: u32,
) -> Result<js_sys::Uint8Array, JsError> {
    argon2id_bytes(input, salt, mem_kib, iters)
        .map(|k| to_js(&k))
        .map_err(js_err)
}

/// Lõi HKDF (SHA-256): dẫn xuất khóa con 32 bytes từ khóa mẹ + `info`.
pub fn hkdf_expand_bytes(master_key: &[u8], info: &[u8]) -> Result<Vec<u8>, String> {
    let hk = Hkdf::<Sha256>::new(None, master_key);
    let mut out = [0u8; KEY_LEN];
    hk.expand(info, &mut out)
        .map_err(|e| format!("hkdf expand failed: {e}"))?;
    Ok(out.to_vec())
}

/// HKDF (SHA-256): dẫn xuất khóa con 32 bytes từ khóa mẹ + context `info`.
#[wasm_bindgen]
pub fn kdf_hkdf_expand(
    master_key: &[u8],
    info: &[u8],
) -> Result<js_sys::Uint8Array, JsError> {
    hkdf_expand_bytes(master_key, info).map(|k| to_js(&k)).map_err(js_err)
}

// ════════════════════════════════════════════════════════════════════════════
// 2. AEAD — mã hóa đối xứng dữ liệu bất kỳ (ChaCha20-Poly1305)
// ════════════════════════════════════════════════════════════════════════════

fn aead_encrypt_bytes(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != KEY_LEN {
        return Err("key must be 32 bytes".into());
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|e| format!("aead encrypt failed: {e}"))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    nonce.zeroize();
    Ok(blob)
}

fn aead_decrypt_bytes(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != KEY_LEN {
        return Err("key must be 32 bytes".into());
    }
    if blob.len() <= NONCE_LEN {
        return Err("malformed encrypted blob".into());
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let out = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "AUTH_FAILED: wrong key or corrupted data".to_string());
    out
}

/// Mã hóa đối xứng tổng quát. Output: `[nonce(12) || ciphertext]`.
#[wasm_bindgen]
pub fn aead_encrypt(key: &[u8], plaintext: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    aead_encrypt_bytes(key, plaintext).map(|b| to_js(&b)).map_err(js_err)
}

/// Giải mã đối xứng tổng quát. Ném lỗi nếu sai khóa / dữ liệu hỏng.
#[wasm_bindgen]
pub fn aead_decrypt(key: &[u8], ciphertext_blob: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    aead_decrypt_bytes(key, ciphertext_blob).map(|b| to_js(&b)).map_err(js_err)
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Chữ ký số — Ed25519
// ════════════════════════════════════════════════════════════════════════════

/// Cặp khóa Ed25519: `privateKey` (32 bytes, cũng là hạt giống / seed) và
/// `publicKey` (32 bytes).
#[derive(Serialize, Deserialize, Clone)]
pub struct Ed25519KeyPair {
    pub privateKey: Vec<u8>,
    pub publicKey: Vec<u8>,
}

fn ed25519_generate_keypair_bytes() -> Ed25519KeyPair {
    let mut rng = rand::thread_rng();
    let signing = SigningKey::generate(&mut rng);
    Ed25519KeyPair {
        privateKey: signing.to_bytes().to_vec(),
        publicKey: signing.verifying_key().to_bytes().to_vec(),
    }
}

fn ed25519_sign_bytes(private_key: &[u8], message: &[u8]) -> Result<Vec<u8>, String> {
    if private_key.len() != KEY_LEN {
        return Err("private key must be 32 bytes".into());
    }
    let mut sk = [0u8; KEY_LEN];
    sk.copy_from_slice(private_key);
    let signing = SigningKey::from_bytes(&sk);
    let sig = signing.sign(message).to_bytes().to_vec();
    sk.zeroize();
    Ok(sig)
}

fn ed25519_verify_bytes(
    public_key: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<bool, String> {
    if public_key.len() != KEY_LEN || signature.len() != 64 {
        return Ok(false);
    }
    let mut pk = [0u8; KEY_LEN];
    pk.copy_from_slice(public_key);
    let vk = VerifyingKey::from_bytes(&pk).map_err(|e| format!("invalid public key: {e}"))?;
    let mut sig = [0u8; 64];
    sig.copy_from_slice(signature);
    Ok(vk.verify(message, &Signature::from_bytes(&sig)).is_ok())
}

/// Sinh cặp khóa Ed25519 ngẫu nhiên.
#[wasm_bindgen]
pub fn ed25519_generate_keypair() -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(&ed25519_generate_keypair_bytes()).map_err(|e| js_err(e.to_string()))
}

/// Ký lên mảng byte bất kỳ → chữ ký 64 bytes.
#[wasm_bindgen]
pub fn ed25519_sign(private_key: &[u8], message: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    ed25519_sign_bytes(private_key, message).map(|b| to_js(&b)).map_err(js_err)
}

/// Xác thực chữ ký. Trả `false` (không ném) nếu không hợp lệ.
#[wasm_bindgen]
pub fn ed25519_verify(
    public_key: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<bool, JsError> {
    ed25519_verify_bytes(public_key, message, signature).map_err(js_err)
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Khóa bất đối xứng & trao đổi khóa — X25519
// ════════════════════════════════════════════════════════════════════════════

/// Quy đổi Ed25519 public key → X25519 public key (Edwards → Montgomery).
pub fn ed25519_pub_to_x25519_bytes(ed_public: &[u8]) -> Result<Vec<u8>, String> {
    if ed_public.len() != KEY_LEN {
        return Err("ed25519 public key must be 32 bytes".into());
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(ed_public);
    let point = CompressedEdwardsY(key)
        .decompress()
        .ok_or_else(|| "invalid ed25519 public key".to_string())?;
    Ok(point.to_montgomery().to_bytes().to_vec())
}

/// Quy đổi Ed25519 private key (seed) → X25519 private key.
///
/// ⚠️ Dùng **SHA-512(seed)[0..32]** (chính là scalar mà Ed25519 dùng để sinh
/// public key, cùng cơ chế clamp) — KHÔNG dùng SHA-256. Nhờ vậy X25519 private
/// này khớp với `ed25519_pub_to_x25519(ed_public)` → DH đối xứng.
pub fn ed25519_priv_to_x25519_bytes(ed_private: &[u8]) -> Result<Vec<u8>, String> {
    if ed_private.len() != KEY_LEN {
        return Err("ed25519 private key must be 32 bytes".into());
    }
    let hash = Sha512::digest(ed_private);
    Ok(hash[..KEY_LEN].to_vec())
}

/// Lõi X25519 Diffie-Hellman → shared secret 32 bytes.
pub fn x25519_diffie_hellman_bytes(
    my_private: &[u8],
    their_public: &[u8],
) -> Result<Vec<u8>, String> {
    if my_private.len() != KEY_LEN || their_public.len() != KEY_LEN {
        return Err("x25519 keys must be 32 bytes".into());
    }
    let mut priv_b = [0u8; KEY_LEN];
    priv_b.copy_from_slice(my_private);
    let mut pub_b = [0u8; KEY_LEN];
    pub_b.copy_from_slice(their_public);
    let secret = StaticSecret::from(priv_b);
    let peer = PublicKey::from(pub_b);
    let out = secret.diffie_hellman(&peer).as_bytes().to_vec();
    priv_b.zeroize();
    pub_b.zeroize();
    Ok(out)
}

#[wasm_bindgen]
pub fn ed25519_pub_to_x25519(ed_public: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    ed25519_pub_to_x25519_bytes(ed_public).map(|b| to_js(&b)).map_err(js_err)
}

#[wasm_bindgen]
pub fn ed25519_priv_to_x25519(ed_private: &[u8]) -> Result<js_sys::Uint8Array, JsError> {
    ed25519_priv_to_x25519_bytes(ed_private).map(|b| to_js(&b)).map_err(js_err)
}

#[wasm_bindgen]
pub fn x25519_diffie_hellman(
    my_private: &[u8],
    their_public: &[u8],
) -> Result<js_sys::Uint8Array, JsError> {
    x25519_diffie_hellman_bytes(my_private, their_public).map(|b| to_js(&b)).map_err(js_err)
}

// ════════════════════════════════════════════════════════════════════════════
// Tests — kiểm chứng tính đúng đắn của các nguyên thủy (thuần Rust, host)
// ════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2id_is_deterministic_and_salt_dependent() {
        let salt = b"salt-16-bytes-!!!";
        let k1 = argon2id_bytes(b"password", salt, 64, 3).unwrap();
        let k2 = argon2id_bytes(b"password", salt, 64, 3).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 32);
        let k3 = argon2id_bytes(b"password", b"another-salt-16", 64, 3).unwrap();
        assert_ne!(k1, k3);
    }

    #[test]
    fn argon2id_rejects_short_salt() {
        assert!(argon2id_bytes(b"pw", b"short", 64, 3).is_err());
    }

    #[test]
    fn hkdf_expand_derives_deterministic_subkeys() {
        let master = [7u8; 32];
        let k1 = hkdf_expand_bytes(&master, b"context-a").unwrap();
        let k2 = hkdf_expand_bytes(&master, b"context-a").unwrap();
        let k3 = hkdf_expand_bytes(&master, b"context-b").unwrap();
        assert_eq!(k1, k2);
        assert_ne!(k1, k3);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn aead_roundtrip_and_wrong_key() {
        let key = [1u8; 32];
        let msg = b"some secret bytes";
        let blob = aead_encrypt_bytes(&key, msg).unwrap();
        // ChaCha20-Poly1305 thêm tag xác thực 16 bytes.
        assert_eq!(blob.len(), NONCE_LEN + msg.len() + 16);
        assert_eq!(aead_decrypt_bytes(&key, &blob).unwrap(), msg.to_vec());

        // Sai khóa → lỗi (không ra dữ liệu).
        let wrong = [2u8; 32];
        assert!(aead_decrypt_bytes(&wrong, &blob).is_err());

        // Cùng plaintext hai lần → blob khác nhau (nonce ngẫu nhiên).
        let blob2 = aead_encrypt_bytes(&key, msg).unwrap();
        assert_ne!(blob, blob2);
    }

    #[test]
    fn ed25519_sign_verify() {
        let kp = ed25519_generate_keypair_bytes();
        let msg = b"hello world";
        let sig = ed25519_sign_bytes(&kp.privateKey, msg).unwrap();
        assert_eq!(sig.len(), 64);
        assert!(ed25519_verify_bytes(&kp.publicKey, msg, &sig).unwrap());
        assert!(!ed25519_verify_bytes(&kp.publicKey, b"tampered", &sig).unwrap());
    }

    #[test]
    fn x25519_dh_is_symmetric() {
        // Hai cặp Ed25519 độc lập.
        let a = ed25519_generate_keypair_bytes();
        let b = ed25519_generate_keypair_bytes();

        // X25519 private tương ứng với seed Ed25519 = SHA512(seed)[0..32]
        // (scalar mà Ed25519 dùng, cùng cách clamp) → khớp ed25519_pub_to_x25519.
        let a_priv = ed25519_priv_to_x25519_bytes(&a.privateKey).unwrap();
        let b_priv = ed25519_priv_to_x25519_bytes(&b.privateKey).unwrap();
        let a_pub = ed25519_pub_to_x25519_bytes(&a.publicKey).unwrap();
        let b_pub = ed25519_pub_to_x25519_bytes(&b.publicKey).unwrap();
        assert_eq!(a_priv.len(), 32);
        assert_eq!(a_pub.len(), 32);

        let sa = x25519_diffie_hellman_bytes(&a_priv, &b_pub).unwrap();
        let sb = x25519_diffie_hellman_bytes(&b_priv, &a_pub).unwrap();
        assert_eq!(sa, sb, "X25519 DH phải đối xứng");
        assert_eq!(sa.len(), 32);
    }
}
