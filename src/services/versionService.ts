//! # VersionService — Lịch sử phiên bản & "Time Travel" trên Automerge
//!
//! Tận dụng DAG history vốn có của Automerge để liệt kê mọi commit chỉnh sửa
//! của một item, và tái dựng lại snapshot tại một mốc commit quá khứ.
//!
//! ## Ghi chú bảo mật
//!   - `getHistory`/`view` hoạt động trên **metadata** của `DriveItemRecord`
//!     (tên mã hóa, ACL, ownerId...). Nội dung file Excel thô nằm trên OPFS
//!     không nằm trong history — phiên bản "nội dung" cần tầng Excel (Phase 7).
//!   - Actor id (`item.change.actor`) là public (không phải bí mật) — an toàn
//!     để hiển thị "ai sửa".

import * as Automerge from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { DriveItemRecord, DriveFileVersion } from "@/types/drive";
import type { ItemHandle } from "@/services/accessService";

export const versionService = {
  /** Lấy toàn bộ lịch sử Commit chỉnh sửa của một File (mới → cũ). */
  getFileHistory(handle: DocHandle<DriveItemRecord>): DriveFileVersion[] {
    const doc = handle.docSync();
    if (!doc) return [];

    // Automerge hỗ trợ lấy toàn bộ history DAG (sắp theo thứ tự tạo).
    const history = Automerge.getHistory(doc);

    return history.map((item) => ({
      commitHash: item.change.hash,
      actorId: item.change.actor,
      timestamp: item.change.time,
      message: item.change.message ?? "Chỉnh sửa bảng tính",
      size: JSON.stringify(item.snapshot).length,
    }));
  },

  /** Xem lại nội dung metadata File tại một mốc commit quá khứ (Time Travel). */
  viewHistoricalVersion(
    handle: DocHandle<DriveItemRecord>,
    targetCommitHash: string,
  ): DriveItemRecord {
    const doc = handle.docSync();
    if (!doc) throw new Error("Document chưa sẵn sàng.");

    // Tái dựng snapshot đúng tại commit hash đó.
    const snapshot = Automerge.view(doc, targetCommitHash as never);
    if (!snapshot) throw new Error("Không tìm thấy phiên bản lịch sử này.");

    return snapshot as DriveItemRecord;
  },

  /**
   * Liệt kê lịch sử có ích cho UI (wrapper tiện dùng khi đã có itemHandle).
   * Tương đương `getFileHistory` nhưng nhận `ItemHandle`.
   */
  listVersions(handle: ItemHandle): DriveFileVersion[] {
    return this.getFileHistory(handle);
  },
};
