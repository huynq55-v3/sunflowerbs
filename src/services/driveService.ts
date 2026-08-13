//! # DriveService — Nghiệp vụ Drive (File/Folder/Trash/Versioning)
//!
//! Tầng "hậu cần": tạo/sửa/xóa metadata, đọc/ghi nội dung file, và **đồng bộ
//! Drive Index** để UI liệt kê cây thư mục.
//!
//! ## Mô hình dữ liệu
//!   - Mỗi File/Folder là **1 Automerge doc riêng** (`DriveItemRecord`, id ngẫu
//!     nhiên) — chứa ACL + metadata mã hóa + transferProof.
//!   - Nội dung file (mã hóa) nằm trên **OPFS**, đánh index theo `item.id`.
//!   - **Drive Index doc** (id cố định) lưu `IndexEntry` công khai để liệt kê.
//!
//! ## Đồng bộ Index
//!   - Mọi thao tác tạo/đổi tên/di chuyển/thùng rác/xóa đều cập nhật ĐỒNG THỜI
//!     `DriveItemRecord` (doc lẻ) VÀ `DriveIndexDoc` (index chung).
//!   - Quy ước **Root folder = parentId null** (KHÔNG dùng chuỗi rỗng).

import { getRepo, createDocument, getDriveIndexUrl, createDriveIndexDoc } from "@/p2p/repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { getCrypto, bytesToBase64, base64ToBytes } from "@/crypto/wasm";
import { opfsStorage } from "@/services/opfsStorage";
import { accessService, type ItemHandle } from "@/services/accessService";
import type { DriveItemRecord, ResourceType } from "@/types/drive";
import type { IndexEntry, DriveIndexDoc } from "@/types/driveIndex";
import type { AuthSession } from "@/services/authService";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─────────────────────────────────────────────────────────────────────────────
// Drive Index (doc cố định) — singleton handle, giống `ensureDirectory`.
// ─────────────────────────────────────────────────────────────────────────────
let indexInitPromise: Promise<DocHandle<DriveIndexDoc> | null> | null = null;

/** Lấy (và nếu cần, bootstrap) handle tới Drive Index doc. */
export function ensureDriveIndex(): Promise<DocHandle<DriveIndexDoc> | null> {
  if (!indexInitPromise) {
    indexInitPromise = (async () => {
      const url = await getDriveIndexUrl();
      try {
        const handle = await getRepo().find<DriveIndexDoc>(url as never);
        await handle.whenReady();
        if (!handle.docSync()?.items) {
          handle.change((d) => {
            if (!d.items) d.items = {};
          });
        }
        return handle;
      } catch (e) {
        // Chưa tồn tại ở đâu → bootstrap máy đầu tiên tại id cố định.
        if (/unavailable/i.test(e instanceof Error ? e.message : String(e))) {
          const created = await createDriveIndexDoc<DriveIndexDoc>({ items: {} });
          created.change((d) => {
            if (!d.items) d.items = {};
          });
          return created;
        }
        console.warn("[drive] index unavailable:", e);
        return null;
      }
    })();
  }
  return indexInitPromise;
}

/** Cập nhật/upsert 1 mục vào Drive Index. */
async function upsertIndex(entry: IndexEntry): Promise<void> {
  const idx = await ensureDriveIndex();
  if (!idx) return;
  idx.change((d) => {
    d.items[entry.id] = entry;
  });
}

/** Xóa 1 mục khỏi Drive Index. */
async function removeFromIndex(itemId: string): Promise<void> {
  const idx = await ensureDriveIndex();
  if (!idx) return;
  idx.change((d) => {
    delete d.items[itemId];
  });
}

/** Dựng IndexEntry từ một DriveItemRecord (trường công khai, KHÔNG chứa tên). */
function toIndexEntry(doc: DriveItemRecord): IndexEntry {
  return {
    id: doc.id,
    type: doc.type,
    parentId: doc.parentId,
    ownerId: doc.ownerId,
    isDeleted: doc.isDeleted,
    updatedAt: doc.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive Service
// ─────────────────────────────────────────────────────────────────────────────
export const driveService = {
  // ── Đọc Index / liệt kê ──

  /** Liệt kê các mục trong một folder (mặc định ẩn mục trong thùng rác). */
  async listItems(
    parentId: string | null,
    includeDeleted = false,
  ): Promise<IndexEntry[]> {
    const idx = await ensureDriveIndex();
    if (!idx) return [];
    const items = idx.docSync()?.items ?? {};
    return Object.values(items).filter(
      (e) => e.parentId === parentId && (includeDeleted || !e.isDeleted),
    );
  },

  /** Lấy IndexEntry của một item theo id; null nếu không có. */
  async getIndexEntry(itemId: string): Promise<IndexEntry | null> {
    const idx = await ensureDriveIndex();
    if (!idx) return null;
    return idx.docSync()?.items?.[itemId] ?? null;
  },

  // ── Tìm handle của 1 item (theo id = documentId) ──

  async getItemHandle(itemId: string): Promise<ItemHandle | null> {
    try {
      const handle = await getRepo().find<DriveItemRecord>(itemId as never);
      await handle.whenReady();
      return handle;
    } catch {
      return null;
    }
  },

  // ── Khóa & mã hóa ──

  /** Giải mã DEK của 1 Item bằng Private Key người dùng. */
  async unwrapDek(item: DriveItemRecord, session: AuthSession): Promise<Uint8Array> {
    const access = item.accessList[session.userId];
    if (!access) throw new Error("Bạn không có quyền mở file này.");

    const crypto = await getCrypto();
    const myX25519Priv = crypto.ed25519_priv_to_x25519(session.privateKey);
    const sharedSecret = crypto.x25519_diffie_hellman(myX25519Priv, session.x25519Public);
    return crypto.aead_decrypt(sharedSecret, base64ToBytes(access.wrappedDek));
  },

  /** Giải mã tên File/Folder rõ. */
  async getItemName(item: DriveItemRecord, session: AuthSession): Promise<string> {
    const dek = await this.unwrapDek(item, session);
    const crypto = await getCrypto();
    const nameBytes = crypto.aead_decrypt(dek, base64ToBytes(item.nameEncrypted));
    return dec.decode(nameBytes);
  },

  // ── Tạo ──

  /** Tạo File mới hoặc Thư mục mới; đồng bộ vào Drive Index. Trả về itemId. */
  async createItem(params: {
    name: string;
    type: ResourceType;
    parentId: string | null;
    content?: Uint8Array;
    session: AuthSession;
  }): Promise<string> {
    const crypto = await getCrypto();

    // Sinh DEK + bọc cho chính Owner.
    const dek = crypto.kdf_hkdf_expand(
      crypto.ed25519_sign(params.session.privateKey, enc.encode(Date.now().toString())),
      enc.encode("item-dek"),
    );
    const myX25519Priv = crypto.ed25519_priv_to_x25519(params.session.privateKey);
    const sharedSecret = crypto.x25519_diffie_hellman(myX25519Priv, params.session.x25519Public);
    const wrappedDek = crypto.aead_encrypt(sharedSecret, dek);

    const nameEncrypted = crypto.aead_encrypt(dek, enc.encode(params.name.trim()));
    const mimeTypeEncrypted = crypto.aead_encrypt(
      dek,
      enc.encode(params.type === "FOLDER" ? "folder" : "application/vnd.ms-excel"),
    );

    const handle = createDocument<DriveItemRecord>();
    const fileId = handle.documentId;

    // Ghi mảng byte mã hóa xuống OPFS cho MỌI FILE (kể cả rỗng).
    // Nếu bỏ qua file rỗng, `openFile()` sẽ lỗi NotFoundError vì chưa có blob.
    if (params.type === "FILE") {
      const plaintext = params.content ?? new Uint8Array(0);
      const encryptedContent = crypto.aead_encrypt(dek, plaintext);
      await opfsStorage.writeFile(fileId, encryptedContent);
    }

    handle.change((doc: DriveItemRecord) => {
      doc.id = fileId;
      doc.type = params.type;
      doc.parentId = params.parentId;
      doc.ownerId = params.session.userId;
      doc.size = params.content ? params.content.length : 0;
      doc.createdAt = Date.now();
      doc.updatedAt = Date.now();
      doc.isDeleted = false;
      doc.nameEncrypted = bytesToBase64(nameEncrypted);
      doc.mimeTypeEncrypted = bytesToBase64(mimeTypeEncrypted);
      doc.accessList = {
        [params.session.userId]: {
          role: "OWNER",
          wrappedDek: bytesToBase64(wrappedDek),
          grantedAt: Date.now(),
        },
      };
    });

    // Đồng bộ vào Drive Index.
    await upsertIndex({
      id: fileId,
      type: params.type,
      parentId: params.parentId,
      ownerId: params.session.userId,
      isDeleted: false,
      updatedAt: Date.now(),
    });

    return fileId;
  },

  // ── Mở / Lưu nội dung ──

  /** Mở FILE: đọc + giải mã nội dung thô từ OPFS (cho Editor/Viewer). */
  async openFile(item: DriveItemRecord, session: AuthSession): Promise<Uint8Array> {
    if (!accessService.canPerform(item, session.userId, "READ")) {
      throw new Error("Bạn không có quyền truy cập file này.");
    }
    const dek = await this.unwrapDek(item, session);
    const encryptedBytes = await opfsStorage.readFile(item.id);
    const crypto = await getCrypto();
    return crypto.aead_decrypt(dek, encryptedBytes);
  },

  /** Lưu nội dung file đã sửa: mã hóa lại + ghi OPFS + cập nhật size/index. */
  async saveFileContent(
    itemHandle: ItemHandle,
    newRawBytes: Uint8Array,
    session: AuthSession,
  ): Promise<void> {
    const item = itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (!accessService.canPerform(item, session.userId, "WRITE")) {
      throw new Error("Bạn chỉ có quyền Viewer, không thể lưu thay đổi.");
    }

    const dek = await this.unwrapDek(item, session);
    const crypto = await getCrypto();
    const encryptedBytes = crypto.aead_encrypt(dek, newRawBytes);
    await opfsStorage.writeFile(item.id, encryptedBytes);

    itemHandle.change((doc: DriveItemRecord) => {
      doc.size = newRawBytes.length;
      doc.updatedAt = Date.now();
    });
    await upsertIndex(toIndexEntry(itemHandle.docSync()!));
  },

  // ── Quản lý metadata ──

  /** Đổi tên File/Folder (Editor & Owner). */
  async renameItem(
    itemHandle: ItemHandle,
    newName: string,
    session: AuthSession,
  ): Promise<void> {
    const item = itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (!accessService.canPerform(item, session.userId, "WRITE")) {
      throw new Error("Bạn chỉ có quyền Viewer, không thể đổi tên File.");
    }

    const dek = await this.unwrapDek(item, session);
    const crypto = await getCrypto();
    const newNameEncrypted = crypto.aead_encrypt(dek, enc.encode(newName.trim()));

    itemHandle.change((doc: DriveItemRecord) => {
      doc.nameEncrypted = bytesToBase64(newNameEncrypted);
      doc.updatedAt = Date.now();
    });
    await upsertIndex(toIndexEntry(itemHandle.docSync()!));
  },

  /** Di chuyển / gỡ file khỏi folder (Editor & Owner). Root = parentId null. */
  async moveItem(
    itemHandle: ItemHandle,
    newParentId: string | null,
    session: AuthSession,
  ): Promise<void> {
    const item = itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (!accessService.canPerform(item, session.userId, "REMOVE_FROM_FOLDER")) {
      throw new Error("Bạn không có quyền di chuyển File này.");
    }

    itemHandle.change((doc: DriveItemRecord) => {
      doc.parentId = newParentId;
      doc.updatedAt = Date.now();
    });
    await upsertIndex(toIndexEntry(itemHandle.docSync()!));
  },

  /** Đưa vào thùng rác / khôi phục (Editor & Owner). */
  async setTrashState(
    itemHandle: ItemHandle,
    isDeleted: boolean,
    session: AuthSession,
  ): Promise<void> {
    const item = itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (!accessService.canPerform(item, session.userId, "WRITE")) {
      throw new Error("Bạn không có quyền thao tác với Thùng rác.");
    }

    itemHandle.change((doc: DriveItemRecord) => {
      doc.isDeleted = isDeleted;
      doc.updatedAt = Date.now();
    });
    await upsertIndex(toIndexEntry(itemHandle.docSync()!));
  },

  /** Xóa vĩnh viễn khỏi OPFS + Index (CHỈ Owner). */
  async deletePermanently(
    itemHandle: ItemHandle,
    session: AuthSession,
  ): Promise<void> {
    const item = itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (!accessService.canPerform(item, session.userId, "DELETE_PERMANENTLY")) {
      throw new Error("Chỉ Owner mới có quyền xóa vĩnh viễn.");
    }

    // Snapshot con cháu TRƯỚC khi biến đổi index (tránh lệch dữ liệu khi đệ quy).
    const children = (await this.listItems(item.id, true)).map((c) => c.id);

    // Xóa blob nội dung trên OPFS (folder không có blob → deleteFile bỏ qua lỗi).
    await opfsStorage.deleteFile(item.id);

    itemHandle.change((doc: DriveItemRecord) => {
      doc.isDeleted = true;
      doc.updatedAt = Date.now();
    });

    // Đệ quy xóa từng con cháu — tránh để lại "file mồ côi" trong Index.
    for (const childId of children) {
      const childHandle = await this.getItemHandle(childId);
      if (childHandle) await this.deletePermanently(childHandle, session);
    }

    await removeFromIndex(item.id);
  },

  // ── Key Rotation (đồng bộ với revokeAccess) ──

  /**
   * Thu hồi quyền kèm **mã hóa lại toàn bộ nội dung** bằng DEK_NEW.
   *
   * Trình tự: lấy DEK cũ → gọi `revokeAccess` (xoay ACL + trả DEK_NEW) → đọc
   * ciphertext OPFS, giải mã bằng DEK cũ, mã hóa lại bằng DEK_NEW, ghi đè.
   * Nếu không re-encrypt, người bị thu hồi (đã giữ DEK cũ) vẫn đọc được dữ liệu.
   */
  async revokeAndReEncrypt(params: {
    itemHandle: ItemHandle;
    targetUserId: string;
    currentUser: AuthSession;
  }): Promise<void> {
    const item = params.itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");

    // Lấy DEK cũ TRƯỚC khi revoke (vì revoke sẽ thay toàn bộ wrappedDek).
    const oldDek = await this.unwrapDek(item, params.currentUser);

    // Xoay ACL + nhận DEK_NEW.
    const newDek = await accessService.revokeAccess(params);

    // Re-encrypt nội dung (chỉ áp dụng cho FILE có blob trên OPFS).
    try {
      const encryptedBytes = await opfsStorage.readFile(item.id);
      const crypto = await getCrypto();
      const plain = crypto.aead_decrypt(oldDek, encryptedBytes);
      const newEncrypted = crypto.aead_encrypt(newDek, plain);
      await opfsStorage.writeFile(item.id, newEncrypted);
    } catch {
      // Folder hoặc file chưa có nội dung cục bộ → chỉ cần rotation ACL (đã xong).
    }
  },
};
