//! # AuthService — Đăng ký · Đăng nhập · Đổi mật khẩu
//!
//! Lắp ghép các nguyên thủy WASM tổng quát (KDF + AEAD + Ed25519). Mọi quyết
//! định nghiệp vụ (validate mật khẩu, thông điệp lỗi) nằm ở đây, trong JS.
//!
//! ## Bảo mật (Zero-Knowledge)
//!   - Mật khẩu → Argon2id → **Master Key** (không bao giờ lưu / gửi đi).
//!   - Master Key chỉ dùng để bọc **seed** (Private Key Ed25519, 32 bytes).
//!   - Vault = { salt + encryptedSeed + publicKeys } — đẩy lên **System_Users_
//!     Directory P2P** để máy khác "gõ username + password là đăng nhập được".
//!
//! ## Luồng
//!   - **Đăng ký**: sinh salt → Master Key → sinh Ed25519 seed → bọc seed →
//!     lưu local + đẩy Vault lên Directory P2P.
//!   - **Đăng nhập**: nếu có record local → dùng luôn. Máy mới → chờ P2P sync,
//!     kéo Vault từ Directory → giải mã → nhập record về.
//!   - **Đổi mật khẩu**: giải mã seed bằng mật khẩu cũ → mã hóa lại bằng mật
//!     khẩu mới (seed KHÔNG đổi) → cập nhật local + Vault trên P2P.
//!
//! KHÔNG có khái niệm admin/status — tài khoản chỉ là cặp khóa mật mã.

import {
  getCrypto,
  bytesToBase64,
  base64ToBytes,
} from "@/crypto/wasm";
import { indexedDb } from "@/storage/indexedDb";
import {
  upsertEntry,
  waitForVault,
  waitForDirectoryReady,
  currentDirectoryUsers,
  getDirectoryError,
} from "@/services/directoryService";

/** Session hiện tại — chỉ nằm trong RAM + session ticket trong tab. */
export interface AuthSession {
  /** Định danh bất biến. */
  userId: string;
  username: string;
  /** Hạt giống / Private Key Ed25519 đã giải mã — chỉ trong bộ nhớ tạm. */
  privateKey: Uint8Array;
  ed25519Public: Uint8Array;
  /** X25519 public (dẫn xuất) — dùng sau này khi Share. */
  x25519Public: Uint8Array;
}

// ── Tham số Argon2id siêu nặng ──
const ARGON_MEM_KIB = 256 * 1024; // 256 MiB
const ARGON_ITERS = 10;

const PASSWORD_MIN_LENGTH = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Sinh byte ngẫu nhiên bằng Web Crypto (nền tảng). */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

let session: AuthSession | null = null;

/** Session ticket trong sessionStorage: sống qua F5 (cùng tab), mất khi đóng tab. */
const SESSION_KEY = "sunflowerbs.session";

function saveSessionToTab(s: AuthSession): void {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        userId: s.userId,
        username: s.username,
        privateKey: bytesToBase64(s.privateKey),
        ed25519Public: bytesToBase64(s.ed25519Public),
        x25519Public: bytesToBase64(s.x25519Public),
      }),
    );
  } catch {
    // sessionStorage đầy/khóa → chỉ mất "giữ phiên trong tab".
  }
}

/**
 * Khôi phục phiên sau F5 từ sessionStorage. Xác minh seed khớp public key
 * (sign/verify) để loại dữ liệu hỏng / bị sửa.
 */
export async function restoreSession(): Promise<AuthSession | null> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    const privateKey = base64ToBytes(d.privateKey);
    const edPub = base64ToBytes(d.ed25519Public);
    const xPub = base64ToBytes(d.x25519Public);
    if (!privateKey.length || !edPub.length || !xPub.length) return null;

    const crypto = await getCrypto();
    const msg = enc.encode("sunflowerbs-session-check");
    const sig = crypto.ed25519_sign(privateKey, msg);
    if (!crypto.ed25519_verify(edPub, msg, sig)) return null; // không khớp → hủy phiên

    session = {
      userId: d.userId,
      username: d.username,
      privateKey,
      ed25519Public: edPub,
      x25519Public: xPub,
    };
    return session;
  } catch {
    return null;
  }
}

/** Sinh userId bất biến: 16 bytes ngẫu nhiên → hex. */
function generateUserId(): string {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Chính sách mật khẩu (100% nằm ở lớp JS — không sửa WASM khi đổi luật)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kiểm tra độ phức tạp mật khẩu.
 * BẮT BUỘC vì Vault (seed mã hóa) công khai trên P2P → phải chống brute-force
 * offline bằng mật khẩu dài + đa nhóm ký tự.
 * @returns chuỗi lỗi (tiếng Việt) nếu không đạt, hoặc `null` nếu hợp lệ.
 */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`;
  }
  if (!/[A-Z]/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ HOA (A-Z).";
  if (!/[a-z]/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ thường (a-z).";
  if (!/[0-9]/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ số (0-9).";
  if (!/[^A-Za-z0-9]/.test(password)) return "Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$...).";
  return null;
}

/** Xác thực mật khẩu đạt chính sách trước khi dùng. */
function assertValidPassword(password: string): void {
  const err = validatePassword(password);
  if (err) throw new Error(err);
}

/** Đẩy Vault của user lên Directory P2P (dùng khi đăng ký / đổi mật khẩu). */
async function pushVault(
  userId: string,
  username: string,
  record: {
    salt: Uint8Array;
    encryptedSeed: Uint8Array;
    ed25519Public: Uint8Array;
    x25519Public: Uint8Array;
  },
): Promise<void> {
  try {
    await upsertEntry(userId, {
      username,
      ed25519Public: bytesToBase64(record.ed25519Public),
      x25519Public: bytesToBase64(record.x25519Public),
      salt: bytesToBase64(record.salt),
      encryptedSeed: bytesToBase64(record.encryptedSeed),
    });
  } catch (e) {
    console.warn("[auth] directory push skipped:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Đăng ký
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Đăng ký tài khoản mới:
 *   salt → Master Key (Argon2id) → sinh Ed25519 seed → bọc seed (AEAD) →
 *   lưu IndexedDB + đẩy Vault lên Directory P2P (để máy khác đăng nhập được).
 */
export async function register(
  usernameRaw: string,
  password: string,
): Promise<{ username: string; userId: string; ed25519Public: Uint8Array }> {
  const username = usernameRaw.trim();
  if (!username) throw new Error("Vui lòng nhập Username.");
  assertValidPassword(password);

  const crypto = await getCrypto();
  const userId = generateUserId();

  const salt = randomBytes(32);
  const masterKey = crypto.kdf_argon2id(enc.encode(password), salt, ARGON_MEM_KIB, ARGON_ITERS);

  const kp = crypto.ed25519_generate_keypair();
  const x25519Public = crypto.ed25519_pub_to_x25519(kp.publicKey);
  const encryptedSeed = crypto.aead_encrypt(masterKey, kp.privateKey);

  await indexedDb.save({
    username,
    userId,
    salt,
    encryptedSeed,
    ed25519Public: kp.publicKey,
    x25519Public,
    createdAt: Date.now(),
  });

  // Đẩy Vault lên P2P — máy khác "gõ username + password" là dùng được ngay.
  await pushVault(userId, username, {
    salt,
    encryptedSeed,
    ed25519Public: kp.publicKey,
    x25519Public,
  });

  return { username, userId, ed25519Public: kp.publicKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Đăng nhập
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Đăng nhập.
 *  1. Có record local → derive Master Key → giải mã seed.
 *  2. Máy mới → chờ Directory P2P sync → kéo Vault → giải mã → nhập record.
 */
export async function login(usernameRaw: string, password: string): Promise<AuthSession> {
  const username = usernameRaw.trim();
  if (!username || !password) throw new Error("Vui lòng nhập Username và Password.");

  const crypto = await getCrypto();

  // 1. Record local (thiết bị đã từng đăng nhập) → dùng luôn, nhanh.
  const record = await indexedDb.get(username);
  if (record) {
    const masterKey = crypto.kdf_argon2id(enc.encode(password), record.salt, ARGON_MEM_KIB, ARGON_ITERS);
    const privateKey = crypto.aead_decrypt(masterKey, record.encryptedSeed);
    session = {
      userId: record.userId,
      username,
      privateKey,
      ed25519Public: record.ed25519Public,
      x25519Public: record.x25519Public,
    };
  } else {
    // 2. Máy mới → kéo Vault từ Directory P2P.
    const vault = await loginFromDirectory(username, password, crypto);
    session = {
      userId: vault.userId,
      username,
      privateKey: vault.privateKey,
      ed25519Public: vault.ed25519Public,
      x25519Public: vault.x25519Public,
    };
  }

  saveSessionToTab(session);
  return session;
}

/** Đăng nhập trên máy mới: kéo Vault từ Directory P2P, giải mã, nhập record. */
async function loginFromDirectory(
  username: string,
  password: string,
  crypto: Awaited<ReturnType<typeof getCrypto>>,
): Promise<{ userId: string; privateKey: Uint8Array; ed25519Public: Uint8Array; x25519Public: Uint8Array }> {
  await waitForDirectoryReady();

  const dirErr = getDirectoryError();
  if (dirErr) {
    throw new Error("Chưa tải được tài khoản: " + dirErr);
  }

  // Chờ P2P sync Vault về `currentUsers` (tránh race: dữ liệu chưa kịp về).
  const vault = await waitForVault(username);
  if (!vault) {
    throw new Error(
      "Chưa tìm thấy tài khoản trên mạng P2P. Hãy đảm bảo thiết bị khác của bạn " +
        "đang online (hoặc relay đang chạy: npm run relay) để đồng bộ về.",
    );
  }

  const masterKey = crypto.kdf_argon2id(enc.encode(password), base64ToBytes(vault.salt), ARGON_MEM_KIB, ARGON_ITERS);
  const privateKey = crypto.aead_decrypt(masterKey, base64ToBytes(vault.encryptedSeed));
  // Nếu sai mật khẩu → ném lỗi.

  const entry = currentDirectoryUsers()[vault.userId];

  // Nhập về thiết bị này để lần sau dùng local (không cần mạng).
  await indexedDb.save({
    username,
    userId: vault.userId,
    salt: base64ToBytes(vault.salt),
    encryptedSeed: base64ToBytes(vault.encryptedSeed),
    ed25519Public: base64ToBytes(entry?.ed25519Public ?? ""),
    x25519Public: base64ToBytes(entry?.x25519Public ?? ""),
    createdAt: Date.now(),
  });

  return {
    userId: vault.userId,
    privateKey,
    ed25519Public: base64ToBytes(entry?.ed25519Public ?? ""),
    x25519Public: base64ToBytes(entry?.x25519Public ?? ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Đổi mật khẩu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Đổi mật khẩu. Seed gốc KHÔNG đổi — chỉ đổi Salt + Master Key + Encrypted
 * Seed, nên dữ liệu cũ không mất. Cập nhật cả local lẫn Vault trên P2P.
 */
export async function changePassword(
  username: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  assertValidPassword(newPassword);
  const crypto = await getCrypto();
  const record = await indexedDb.get(username.trim());
  if (!record) throw new Error("Tài khoản không tồn tại.");

  // 1. Mật khẩu cũ + salt cũ → Master Key cũ → giải mã seed gốc (không đổi).
  const oldMasterKey = crypto.kdf_argon2id(enc.encode(oldPassword), record.salt, ARGON_MEM_KIB, ARGON_ITERS);
  const seed = crypto.aead_decrypt(oldMasterKey, record.encryptedSeed);

  // 2. Salt mới + Master Key mới → bọc LẠI cùng seed.
  const newSalt = randomBytes(32);
  const newMasterKey = crypto.kdf_argon2id(enc.encode(newPassword), newSalt, ARGON_MEM_KIB, ARGON_ITERS);
  const encryptedSeed = crypto.aead_encrypt(newMasterKey, seed);

  await indexedDb.update(username.trim(), { salt: newSalt, encryptedSeed });

  // 3. Cập nhật Vault trên P2P để máy mới dùng mật khẩu mới.
  await pushVault(record.userId, record.username, {
    salt: newSalt,
    encryptedSeed,
    ed25519Public: record.ed25519Public,
    x25519Public: record.x25519Public,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Lấy session đang hoạt động (nếu có) — chỉ trong RAM. */
export function getSession(): AuthSession | null {
  return session;
}

/** Lấy userId của user đang đăng nhập; ném lỗi nếu chưa đăng nhập. */
export function requireLoginUserId(): string {
  const s = session;
  if (!s) throw new Error("Bạn chưa đăng nhập.");
  return s.userId;
}

/** Đăng xuất: xóa sạch seed khỏi RAM + session ticket trong tab. */
export function logout(): void {
  session = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // noop
  }
}

/** Kiểm chứng nhanh một mật khẩu hiện có đúng hay không (cho form đổi MK). */
export async function verifyPassword(username: string, password: string): Promise<boolean> {
  try {
    const crypto = await getCrypto();
    const record = await indexedDb.get(username.trim());
    if (!record) return false;
    const mk = crypto.kdf_argon2id(enc.encode(password), record.salt, ARGON_MEM_KIB, ARGON_ITERS);
    crypto.aead_decrypt(mk, record.encryptedSeed);
    return true;
  } catch {
    return false;
  }
}

export { dec as utf8Decode };
