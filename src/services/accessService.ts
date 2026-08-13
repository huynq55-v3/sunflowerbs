//! # AccessService — Phân quyền & Validator mật mã trên Automerge P2P
//!
//! Quản lý ACL (`accessList`) của từng File/Folder: cấp quyền, thu hồi (kèm
//! đổi ổ khóa DEK), chuyển giao quyền sở hữu, và các validator gác cổng.
//!
//! ## Mô hình khóa (Zero-Knowledge)
//!   - Mỗi item có một **DEK** (Data Encryption Key, 32 bytes).
//!   - DEK được "bọc" riêng cho từng user trong `accessList[userId].wrappedDek`
//!     bằng shared secret X25519 giữa Owner và user đó.
//!   - Khi **thu hồi** một người → sinh **DEK mới** và bọc lại cho tất cả user
//!     còn lại (Key Rotation) → người bị thu hồi không còn đọc được dữ liệu cũ.
//!   - Khi **chuyển giao Owner** → ký Ed25519 một `transferProof` để chứng minh
//!     nhượng quyền hợp lệ (chống giả mạo ownerId).
//!
//! ## Ghi chú về Public Key
//!   - `AuthSession.x25519Public` / `ed25519Public` là **Uint8Array** (từ RAM).
//!   - `DirectoryEntry.x25519Public` / `ed25519Public` là **base64 string**.
//!   - Dùng helper `toBytes()` để xử lý nhất quán cả 2 dạng.

import { getCrypto, bytesToBase64, base64ToBytes } from "@/crypto/wasm";
import type { DocHandle } from "@automerge/automerge-repo";
import type { DriveItemRecord, ShareRole } from "@/types/drive";
import type { AuthSession } from "@/services/authService";
import { currentDirectoryUsers } from "@/services/directoryService";

/** Item handle kiểu hóa cho các hàm service. */
export type ItemHandle = DocHandle<DriveItemRecord>;

const enc = new TextEncoder();

/** Coerce public-key value (base64 string | Uint8Array) → Uint8Array. */
function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? base64ToBytes(v) : v;
}

export const accessService = {
  /** 1. Cấp quyền Share (Chỉ Owner mới được gọi). */
  async grantAccess(params: {
    itemHandle: ItemHandle;
    targetUserId: string;
    role: ShareRole;
    currentUser: AuthSession;
  }): Promise<void> {
    const item = params.itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");

    if (item.ownerId !== params.currentUser.userId) {
      throw new Error("Chỉ Owner mới có quyền cấp phép chia sẻ.");
    }

    const targetUser = currentDirectoryUsers()[params.targetUserId];
    if (!targetUser) throw new Error("Không tìm thấy người dùng trong danh bạ P2P.");

    const crypto = await getCrypto();
    const myX25519Priv = crypto.ed25519_priv_to_x25519(params.currentUser.privateKey);

    // Mở bọc DEK của Owner.
    const ownerAccess = item.accessList[params.currentUser.userId];
    const sharedSecretOwner = crypto.x25519_diffie_hellman(
      myX25519Priv,
      params.currentUser.x25519Public, // Uint8Array (trực tiếp từ session)
    );
    const dek = crypto.aead_decrypt(sharedSecretOwner, base64ToBytes(ownerAccess.wrappedDek));

    // Bọc DEK cho Target User (directory entry là base64 string).
    const sharedSecretTarget = crypto.x25519_diffie_hellman(
      myX25519Priv,
      toBytes(targetUser.x25519Public),
    );
    const targetWrappedDek = crypto.aead_encrypt(sharedSecretTarget, dek);

    params.itemHandle.change((doc: DriveItemRecord) => {
      doc.accessList[params.targetUserId] = {
        role: params.role,
        wrappedDek: bytesToBase64(targetWrappedDek),
        grantedAt: Date.now(),
      };
      doc.updatedAt = Date.now();
    });
  },

  /** 2. Thu hồi quyền (Revoke) → Kích hoạt Đổi Ổ Khóa (Key Rotation). */
  async revokeAccess(params: {
    itemHandle: ItemHandle;
    targetUserId: string;
    currentUser: AuthSession;
  }): Promise<Uint8Array> {
    const item = params.itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (item.ownerId !== params.currentUser.userId) {
      throw new Error("Chỉ Owner mới có quyền thu hồi chia sẻ.");
    }

    const crypto = await getCrypto();
    const myX25519Priv = crypto.ed25519_priv_to_x25519(params.currentUser.privateKey);

    // Sinh DEK_NEW hoàn toàn mới (kể cả cho chính Owner).
    const newDek = crypto.kdf_hkdf_expand(
      crypto.ed25519_sign(params.currentUser.privateKey, enc.encode(Date.now().toString())),
      enc.encode("key-rotation"),
    );

    const newAccessList: Record<string, any> = {};

    for (const [userId, access] of Object.entries(item.accessList)) {
      if (userId === params.targetUserId) continue; // Bỏ qua người bị thu hồi.

      // Owner LUÔN dùng public key trực tiếp từ session — tránh phụ thuộc vào
      // directory chưa sync (nếu không, có thể làm rơi entry của chính Owner).
      const userX25519Pub =
        userId === params.currentUser.userId
          ? params.currentUser.x25519Public
          : (() => {
              const userPublic = currentDirectoryUsers()[userId];
              if (!userPublic) return null;
              return toBytes(userPublic.x25519Public);
            })();

      if (!userX25519Pub) continue;

      const sharedSecret = crypto.x25519_diffie_hellman(myX25519Priv, userX25519Pub);
      const wrappedDek = crypto.aead_encrypt(sharedSecret, newDek);

      newAccessList[userId] = {
        role: access.role,
        wrappedDek: bytesToBase64(wrappedDek),
        grantedAt: access.grantedAt,
      };
    }

    params.itemHandle.change((doc: DriveItemRecord) => {
      doc.accessList = newAccessList;
      doc.updatedAt = Date.now();
    });

    // ⚠️ Trả về DEK_NEW — gọi bên (driveService) PHẢI mã hóa lại nội dung file
    // trên OPFS bằng newDek này. Nếu bỏ qua, dữ liệu cũ (DEK_OLD) vẫn đọc được.
    return newDek;
  },

  /** 3. Chuyển giao quyền Chủ Sở Hữu (Transfer Ownership). */
  async transferOwnership(params: {
    itemHandle: ItemHandle;
    newOwnerId: string;
    currentUser: AuthSession;
  }): Promise<void> {
    const item = params.itemHandle.docSync();
    if (!item) throw new Error("File/Folder không tồn tại.");
    if (item.ownerId !== params.currentUser.userId) {
      throw new Error("Chỉ Owner mới có quyền chuyển giao quyền sở hữu.");
    }

    const newUser = currentDirectoryUsers()[params.newOwnerId];
    if (!newUser) throw new Error("Người dùng mới không tồn tại.");

    const crypto = await getCrypto();

    // Bằng chứng ký Ed25519 nhượng quyền.
    const proofMessage = `TRANSFER_OWNERSHIP:${item.id}:${params.newOwnerId}:${Date.now()}`;
    const proofSignature = crypto.ed25519_sign(
      params.currentUser.privateKey,
      enc.encode(proofMessage),
    );

    // Mở bọc DEK cũ và bọc lại cho Owner mới.
    const myX25519Priv = crypto.ed25519_priv_to_x25519(params.currentUser.privateKey);
    const ownerAccess = item.accessList[params.currentUser.userId];
    const sharedSecretOld = crypto.x25519_diffie_hellman(
      myX25519Priv,
      params.currentUser.x25519Public,
    );
    const dek = crypto.aead_decrypt(sharedSecretOld, base64ToBytes(ownerAccess.wrappedDek));

    const sharedSecretNew = crypto.x25519_diffie_hellman(
      myX25519Priv,
      toBytes(newUser.x25519Public),
    );
    const newOwnerWrappedDek = crypto.aead_encrypt(sharedSecretNew, dek);

    params.itemHandle.change((doc: DriveItemRecord) => {
      doc.ownerId = params.newOwnerId;
      doc.accessList[params.newOwnerId] = {
        role: "OWNER",
        wrappedDek: bytesToBase64(newOwnerWrappedDek),
        grantedAt: Date.now(),
      };
      if (doc.accessList[params.currentUser.userId]) {
        doc.accessList[params.currentUser.userId].role = "EDITOR";
      }
      doc.transferProof = {
        message: proofMessage,
        signature: bytesToBase64(proofSignature),
        previousOwnerId: params.currentUser.userId,
        transferredAt: Date.now(),
      };
      doc.updatedAt = Date.now();
    });
  },

  /** 4. Validator gác cổng: Kiểm tra tính hợp lệ của Owner (transferProof). */
  async validateOwnership(doc: DriveItemRecord): Promise<boolean> {
    if (!doc.transferProof) return true; // Chưa từng nhượng quyền → hợp lệ.
    try {
      const crypto = await getCrypto();
      const prevOwner = currentDirectoryUsers()[doc.transferProof.previousOwnerId];
      if (!prevOwner) return false;

      return crypto.ed25519_verify(
        toBytes(prevOwner.ed25519Public),
        enc.encode(doc.transferProof.message),
        base64ToBytes(doc.transferProof.signature),
      );
    } catch {
      return false;
    }
  },

  /**
   * 5. Kiểm tra toàn vẹn (invariants) của một DriveItemRecord.
   *
   * Bất khả tri về actor (không phụ thuộc ai đã sửa) — chỉ kiểm tra các BẤT BIẾN
   * mật mã/phân quyền phải luôn đúng. Mọi thao tác hợp lệ đều bảo toàn chúng,
   * nên không sinh false-positive cho chính mình.
   *
   * @returns chuỗi mô tả vi phạm, hoặc `null` nếu hợp lệ.
   */
  async validateIntegrity(
    doc: DriveItemRecord,
    before?: DriveItemRecord | null,
  ): Promise<string | null> {
    // (a) Owner phải giữ quyền OWNER trong chính accessList.
    if (doc.accessList[doc.ownerId]?.role !== "OWNER") {
      return `Owner "${doc.ownerId}" không còn giữ quyền OWNER trong accessList (bị can thiệp).`;
    }

    // (b) Chỉ ownerId mới được giữ role OWNER (chống Editor tự nâng cấp).
    for (const [userId, acc] of Object.entries(doc.accessList)) {
      if (acc.role === "OWNER" && userId !== doc.ownerId) {
        return `User "${userId}" chiếm role OWNER không hợp lệ (không phải ownerId).`;
      }
    }

    // (c) Nếu ownerId đổi so với trước → bắt buộc có transferProof hợp lệ.
    if (before && before.ownerId !== doc.ownerId && !(await this.validateOwnership(doc))) {
      return `Đổi ownerId gian lận (${before.ownerId} → ${doc.ownerId}): transferProof không hợp lệ.`;
    }

    // (d) Mọi entry trong accessList phải có wrappedDek (chống entry rỗng).
    for (const [userId, acc] of Object.entries(doc.accessList)) {
      if (!acc.wrappedDek) {
        return `Entry của "${userId}" thiếu wrappedDek.`;
      }
    }

    return null;
  },

  /**
   * 6. Continuous P2P Validation Hook — gác cổng ngầm 24/7.
   *
   * Đăng ký lắng nghe `change` của item; mỗi khi doc đổi (local hay P2P), chạy
   * `validateIntegrity` so sánh với trạng thái trước (`patchInfo.before`). Nếu
   * vi phạm → bắn CustomEvent `p2p-unauthorized-edit` để UI cảnh báo/rollback.
   *
   * @returns hàm hủy subscribe (dùng trong `useEffect`).
   */
  setupP2PValidation(handle: ItemHandle): () => void {
    const onChange = (payload: {
      doc: DriveItemRecord;
      patchInfo?: { before?: DriveItemRecord | null };
    }) => {
      const doc = { ...payload.doc }; // bản mutable để truyền vào validator
      const before = payload.patchInfo?.before ? { ...payload.patchInfo.before } : null;

      // Chạy bất đồng bộ, không chặn vòng lặp CRDT.
      void this.validateIntegrity(doc, before).then((violation) => {
        if (violation) {
          console.warn("🚨 [P2P Security Violation]", violation);
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("p2p-unauthorized-edit", {
                detail: { docId: doc.id, reason: violation, validDoc: before },
              }),
            );
          }
        }
      });
    };

    handle.on("change", onChange);
    return () => handle.off("change", onChange);
  },

  /** 7. Hàm cho UI: User có được thực hiện hành động hay không. */
  canPerform(
    item: DriveItemRecord,
    userId: string,
    action: "READ" | "WRITE" | "REMOVE_FROM_FOLDER" | "DELETE_PERMANENTLY" | "SHARE",
  ): boolean {
    const access = item.accessList[userId];
    if (!access) return false;

    const role = access.role;
    if (action === "READ") return true;
    if (action === "WRITE" || action === "REMOVE_FROM_FOLDER") {
      return role === "OWNER" || role === "EDITOR";
    }
    if (action === "DELETE_PERMANENTLY" || action === "SHARE") {
      return role === "OWNER";
    }
    return false;
  },
};
