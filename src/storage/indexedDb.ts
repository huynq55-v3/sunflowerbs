//! IndexedDB Wrapper — lưu record tài khoản cục bộ.
//!
//! Mỗi record tài khoản gồm:
//!   * `username`            — khóa chính (dùng lookup khi đăng nhập)
//!   * `userId`              — định danh BẤT BIẾN
//!   * `salt`                — salt 32 bytes của Argon2id
//!   * `encryptedSeed`       — blob (nonce || ciphertext) bọc hạt giống Private Key
//!   * `ed25519Public`       — public key đăng ký
//!   * `x25519Public`        — public key mã hóa (dùng sau này khi Share)
//!
//! Lưu ý Zero-Knowledge: **chỉ** lưu Salt + Encrypted Seed. Không lưu mật khẩu,
//! không lưu Master Key, không lưu Private Key dạng thô.
//!
//! KHÔNG có khái niệm admin/status — tài khoản chỉ là cặp khóa mật mã.

export interface AccountRecord {
  /** Tên đăng nhập — khóa lookup cục bộ khi đăng nhập. */
  username: string;
  /** Định danh bất biến (sinh ngẫu nhiên). */
  userId: string;
  salt: Uint8Array;
  /** Blob `nonce(12) || ciphertext` — kết quả `aead_encrypt` bọc seed. */
  encryptedSeed: Uint8Array;
  ed25519Public: Uint8Array;
  x25519Public: Uint8Array;
  createdAt: number;
}

const DB_NAME = import.meta.env.VITE_DB_NAME ?? "sunflowerbs";
const STORE = import.meta.env.VITE_DB_ACCOUNTS_STORE ?? "accounts";
// v3: bỏ index "status" (không còn khái niệm status/admin).
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "username" });
        store.createIndex("userId", "userId", { unique: true });
      } else if (oldVersion < 3) {
        // Migration v2 → v3: bỏ index "status" (đã bỏ khái niệm status/admin).
        const store = req.transaction?.objectStore(STORE);
        if (store && store.indexNames.contains("status")) store.deleteIndex("status");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const request = run(t.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB op failed"));
      }),
  );
}

export const indexedDb = {
  /** Upsert một tài khoản (dùng khi đăng ký & đổi mật khẩu). */
  save(record: AccountRecord): Promise<IDBValidKey> {
    return tx("readwrite", (s) => s.put(record));
  },

  /** Lấy record theo username. Trả về `null` nếu chưa tồn tại. */
  get(username: string): Promise<AccountRecord | undefined> {
    return tx("readonly", (s) => s.get(username));
  },

  /** Cập nhật một phần record (giữ nguyên các trường khác). */
  update(username: string, patch: Partial<AccountRecord>): Promise<void> {
    return this.get(username).then((existing) => {
      if (!existing) throw new Error(`Account "${username}" not found`);
      return this.save({ ...existing, ...patch }).then(() => undefined);
    });
  },

  /** Xóa tài khoản. */
  remove(username: string): Promise<void> {
    return tx("readwrite", (s) => s.delete(username)).then(() => undefined);
  },

  /** Liệt kê toàn bộ tài khoản (dùng cho admin / debug). */
  list(): Promise<AccountRecord[]> {
    return tx("readonly", (s) => s.getAll());
  },

  async deleteDatabase(): Promise<void> {
    dbPromise = null;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("delete failed"));
    });
  },
};
