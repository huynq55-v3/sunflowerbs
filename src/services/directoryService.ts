//! # System_Users_Directory — Bảng danh bạ người dùng dùng chung (P2P)
//!
//! Một Automerge document P2P chứa danh sách user trong workspace:
//!
//! ```ts
//! {
//!   users: {
//!     [userId]: {
//!       username, ed25519Public, x25519Public,
//!       salt,            // base64 — salt Argon2id
//!       encryptedSeed    // base64 — seed (Private Key) đã mã hóa = "Vault"
//!     }
//!   }
//! }
//! ```
//!
//! ## Đăng nhập trên máy mới (Username + Password)
//!   Vault (seed mã hóa) được đẩy lên đây khi đăng ký / đổi mật khẩu. Máy mới
//!   chỉ cần gõ Username + Password → tự kéo Vault về → giải mã → vào app.
//!   Không cần copy/paste chuỗi Vault thủ công.
//!
//! ## Bảo mật
//!   Dữ liệu ở đây là **public key + Vault đã mã hóa** — công khai trên P2P là
//!   an toàn vì muốn mở seed phải có mật khẩu (Argon2id siêu nặng).
//!
//! ## Không có admin/status
//!   Tài khoản chỉ là cặp khóa mật mã — ai có khóa thì mở được, không có khái
//!   niệm "khóa tài khoản" ở mức status.

import { getRepo, getDirectoryUrl, createDirectoryDoc } from "@/p2p/repo";
import type { DocHandle } from "@automerge/automerge-repo";

/** Một entry trong directory (public info + Vault mã hóa). */
export interface DirectoryEntry {
  username: string;
  /** Base64 của Ed25519 public key. */
  ed25519Public: string;
  /** Base64 của X25519 public key. */
  x25519Public: string;
  /** Base64 salt Argon2id. */
  salt?: string;
  /** Base64 seed (Private Key) đã mã hóa bằng Master Key. */
  encryptedSeed?: string;
}

/** Shape của Automerge document System_Users_Directory. */
export interface DirectoryDoc {
  users: Record<string, DirectoryEntry>;
}

let initPromise: Promise<DocHandle<DirectoryDoc> | null> | null = null;

/** Lỗi nếu không với tới được directory (thân thiện với người dùng). */
let dirError: string | null = null;

export function getDirectoryError(): string | null {
  return dirError;
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unavailable/i.test(msg)) {
    return (
      "Không kết nối được System_Users_Directory. Cần ít nhất một thiết bị khác " +
      "online (hoặc bật relay: npm run relay) để đồng bộ dữ liệu về."
    );
  }
  return msg;
}

/**
 * Khởi tạo (một lần) handle tới directory chung của workspace.
 *  - Doc CHƯA tồn tại (workspace mới / máy đầu tiên) → khởi tạo `users = {}`
 *    tại đúng id cố định; các máy khác tìm thấy doc này qua P2P.
 */
export function ensureDirectory(): Promise<DocHandle<DirectoryDoc> | null> {
  if (!initPromise) {
    initPromise = (async () => {
      const repo = getRepo();
      const url = await getDirectoryUrl();
      try {
        const handle = await repo.find<DirectoryDoc>(url as never);
        await handle.whenReady();
        // Máy đầu tiên khởi tạo doc nếu rỗng (CRDT merge nếu 2 máy cùng lúc).
        if (!handle.docSync()?.users) {
          handle.change((d) => {
            if (!d.users) d.users = {};
          });
        }
        dirError = null;
        return handle;
      } catch (e) {
        // Doc CHƯA tồn tại ở bất kỳ đâu → bootstrap tạo mới tại id cố định
        // (máy đầu tiên của workspace). `createDirectoryDoc` dùng idFactory → đúng id.
        if (/unavailable/i.test(e instanceof Error ? e.message : String(e))) {
          console.warn("[directory] chưa tồn tại → bootstrap create2");
          const created = await createDirectoryDoc<DirectoryDoc>({ users: {} });
          created.change((d) => {
            if (!d.users) d.users = {};
          });
          dirError = null;
          return created;
        }
        dirError = friendlyError(e);
        console.warn("[directory] unavailable:", e);
        return null;
      }
    })();
  }
  return initPromise;
}

/** Đăng ký / cập nhật entry của một user trong directory (upsert theo userId). */
export async function upsertEntry(userId: string, entry: DirectoryEntry): Promise<void> {
  const handle = await ensureDirectory();
  if (!handle) {
    console.warn("[directory] upsert skipped, directory unavailable");
    return;
  }
  handle.change((d) => {
    d.users[userId] = entry;
  });
}

// Cache bản local để UI đọc đồng bộ.
let currentUsers: Record<string, DirectoryEntry> = {};

/** Bản users mới nhất đã sync (đọc trực tiếp, không chờ). */
export function currentDirectoryUsers(): Record<string, DirectoryEntry> {
  return currentUsers;
}

/**
 * Đăng ký listener: gọi `cb(users)` mỗi khi directory thay đổi (local hay P2P).
 * Trả về hàm hủy subscribe.
 */
export async function subscribeDirectory(
  cb: (users: Record<string, DirectoryEntry>) => void,
): Promise<() => void> {
  const handle = await ensureDirectory();
  if (!handle) {
    currentUsers = {};
    cb(currentUsers);
    return () => {};
  }
  currentUsers = handle.docSync()?.users ?? {};
  cb(currentUsers);

  const onChange = () => {
    currentUsers = handle.docSync()?.users ?? {};
    cb(currentUsers);
  };
  handle.on("change", onChange);
  return () => handle.off("change", onChange);
}

/** Lấy X25519 public key (base64) của một userId (dùng sau này khi Share). */
export function getX25519Public(userId: string): string | undefined {
  return currentUsers[userId]?.x25519Public;
}

/**
 * Tìm Vault (salt + encryptedSeed) theo username trong bản đã sync.
 * Chỉ dùng để đọc nhanh; khi đăng nhập máy mới hãy dùng `waitForVault`.
 */
export function findVaultByUsername(username: string): {
  userId: string;
  salt: string;
  encryptedSeed: string;
} | null {
  const matches = Object.entries(currentUsers).filter(
    ([, e]) => e.username === username && e.salt && e.encryptedSeed,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn("nhiều vault trùng username — dùng entry gần nhất:", matches.length);
  }
  const [userId, e] = matches[matches.length - 1];
  return { userId, salt: e.salt!, encryptedSeed: e.encryptedSeed! };
}

/**
 * Đợi Vault của một username xuất hiện trong directory (đã sync P2P về).
 *
 * Vì dữ liệu từ Relay/peer khác có thể chậm vài trăm ms, hàm này poll
 * `currentUsers` cho tới khi thấy vault hoặc hết `timeoutMs`.
 * @returns Vault nếu tìm thấy; `null` nếu hết thời gian chờ.
 */
export function waitForVault(
  username: string,
  timeoutMs = 5000,
): Promise<{ userId: string; salt: string; encryptedSeed: string } | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = findVaultByUsername(username);
      if (found) return resolve(found);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** Đợi directory được load xong (dùng trước khi tìm vault trên máy mới). */
export function waitForDirectoryReady(): Promise<void> {
  return ensureDirectory().then(() => undefined);
}
