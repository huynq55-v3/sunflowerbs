//! # OPFS Storage — Đọc/ghi mảng byte đã mã hóa xuống Origin Private File System
//!
//! OPFS (`navigator.storage.getDirectory()`) là vùng đĩa cục bộ trong trình
//! duyệt, nhanh và phù hợp để lưu nội dung file thô (đã mã hóa). Byte dữ liệu
//! được ghi xuống đây KHÔNG BAO GIỜ ở dạng rõ — luôn là blob mã hóa từ WASM.
//!
//! ## Bảo mật (Zero-Knowledge)
//!   - Chỉ lưu ciphertext. Khóa DEK nằm trong metadata `DriveItemRecord`
//!     (Automerge P2P), không bao giờ lưu dạng thô lên đĩa.
//!   - Đánh index file theo `fileId` (= documentId của Automerge doc).
//!
//! ## Yêu cầu môi trường
//!   - OPFS chỉ hoạt động trong **secure context** (HTTPS hoặc localhost).
//!   - Gọi `ensureStorage()` trước khi đọc/ghi lần đầu để kiểm tra + tăng
//!     khả năng dữ liệu không bị trình duyệt evict (xóa do hết dung lượng).

export const opfsStorage = {
  /**
   * Kiểm tra context an toàn + xin quyền persist (giảm nguy cơ bị evict).
   * Nên gọi một lần khi khởi tạo Drive.
   * @throws Error nếu không phải secure context.
   */
  async ensureStorage(): Promise<void> {
    if (typeof window !== "undefined" && !window.isSecureContext) {
      throw new Error(
        "OPFS yêu cầu context an toàn (HTTPS hoặc localhost). " +
          "Vui lòng mở app qua https:// hoặc http://localhost.",
      );
    }
    try {
      if (navigator.storage?.persist) {
        await navigator.storage.persist();
      }
    } catch {
      // persist chỉ là "best-effort" — không fail nếu trình duyệt từ chối.
    }
  },

  /** Thư mục gốc của OPFS trong origin này. */
  async getRootFolder(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory();
  },

  /** Ghi đống byte (đã mã hóa) xuống đĩa OPFS. */
  async writeFile(fileId: string, encryptedData: Uint8Array): Promise<void> {
    const root = await this.getRootFolder();
    const fileHandle = await root.getFileHandle(fileId, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      // wasm trả Uint8Array<ArrayBufferLike>; OPFS cần ArrayBuffer-backed buffer.
      const data: ArrayBufferView<ArrayBuffer> =
        encryptedData as unknown as ArrayBufferView<ArrayBuffer>;
      await writable.write(data);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => {});
      throw e;
    }
  },

  /** Đọc đống byte (đã mã hóa) từ OPFS lên RAM. */
  async readFile(fileId: string): Promise<Uint8Array> {
    const root = await this.getRootFolder();
    const fileHandle = await root.getFileHandle(fileId);
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  },

  /** Xóa vĩnh viễn file khỏi đĩa OPFS (bỏ qua nếu chưa từng tồn tại). */
  async deleteFile(fileId: string): Promise<void> {
    try {
      const root = await this.getRootFolder();
      await root.removeEntry(fileId);
    } catch {
      // File có thể chưa từng tồn tại cục bộ — coi như đã xóa.
    }
  },
};
