//! # Drive Index Types — Danh mục các File/Folder trong ổ đĩa P2P
//!
//! Vì mỗi File/Folder là 1 Automerge Document riêng với id ngẫu nhiên, nên cần
//! một **Drive Index Doc** tập trung (id cố định theo workspace) để liệt kê
//! "user đang có những file nào / nằm ở folder nào". Automerge không hỗ trợ
//! query, vì vậy Index là bắt buộc để UI render được cây thư mục.
//!
//! Index chỉ chứa metadata CÔNG KHAI (không có tên mã hóa — tên nằm trong doc
//! riêng của từng item). Tránh lộ thông tin qua index.

export type IndexResourceType = 'FILE' | 'FOLDER';

/** Một mục (item) trong Index — metadata tối thiểu để liệt kê & định vị. */
export interface IndexEntry {
  id: string;
  type: IndexResourceType;
  parentId: string | null;
  ownerId: string;
  isDeleted: boolean;
  updatedAt: number;
}

/** Shape của Automerge Document Drive Index (1 doc cố định cho workspace). */
export interface DriveIndexDoc {
  items: Record<string, IndexEntry>; // itemId -> IndexEntry
}
