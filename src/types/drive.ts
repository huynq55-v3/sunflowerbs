//! # Drive Types — Định nghĩa cấu trúc Metadata cho CSDL Automerge P2P
//! File path: src/types/drive.ts

export type ResourceType = 'FILE' | 'FOLDER';
export type ShareRole = 'OWNER' | 'EDITOR' | 'VIEWER';

/** Bảng Chìa Khóa & Phân Quyền (Access Control List) */
export interface AccessControlEntry {
  role: ShareRole;
  /** DEK đã bọc bằng Public Key (X25519) của User */
  wrappedDek: string; // Base64
  grantedAt: number;
}

/** Bằng chứng Mật mã khi Owner A nhượng quyền cho Owner B */
export interface OwnershipTransferProof {
  message: string;
  signature: string; // Base64 Chữ ký Ed25519 của Owner cũ
  previousOwnerId: string;
  transferredAt: number;
}

/** Record Metadata đại diện cho 1 File hoặc Folder trên Automerge */
export interface DriveItemRecord {
  // 🌐 A. TRƯỜNG CÔNG KHAI (PLAINTEXT)
  id: string;
  type: ResourceType;
  parentId: string | null;
  ownerId: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  isDeleted: boolean;

  accessList: {
    [userId: string]: AccessControlEntry;
  };

  /** Bằng chứng nhượng quyền (null nếu chưa từng nhượng quyền) */
  transferProof?: OwnershipTransferProof | null;

  // 🔒 B. TRƯỜNG BẢO BẬT (ENCRYPTED - Base64 [nonce || ciphertext])
  nameEncrypted: string;
  mimeTypeEncrypted: string;
}

/** Cấu trúc 1 Phiên bản Lịch sử (Version History Item) */
export interface DriveFileVersion {
  commitHash: string;
  actorId: string;
  timestamp: number;
  message: string;
  size: number;
}
