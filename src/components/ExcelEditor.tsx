//! # ExcelEditor — Trình chỉnh sửa bảng tính FortuneSheet + Lịch sử phiên bản
//!
//! Luồng:
//!   1. `openFile()` đọc + giải mã nội dung Excel từ OPFS.
//!   2. `LuckyExcel.transformExcelToLucky()` chuyển xlsx → dữ liệu FortuneSheet.
//!   3. `<Workbook />` hiển thị; `allowEdit = canPerform(WRITE)` (Viewer chỉ đọc).
//!   4. Lưu: `workbookRef.getAllSheets()` → convert sang xlsx (`xlsx` lib) →
//!      `saveFileContent()` mã hóa + ghi OPFS.
//!   5. Sidebar lịch sử phiên bản từ `versionService` (mới nhất lên trên).
//!
//! Lưu ý: `LuckyExcel.transformLuckyToExcel()` RỖNG → phải tự convert bằng `xlsx`.

import { useCallback, useEffect, useRef, useState } from "react";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import "@fortune-sheet/react/dist/index.css";
import LuckyExcel from "luckyexcel";
import * as XLSX from "xlsx";
import { driveService } from "@/services/driveService";
import { versionService } from "@/services/versionService";
import { accessService } from "@/services/accessService";
import type { AuthSession } from "@/services/authService";
import type { DriveFileVersion } from "@/types/drive";

// ── Convert dữ liệu FortuneSheet → mảng byte xlsx ──

/** Trích giá trị thô của một cell (FortuneSheet `v`). */
function cellValue(v: unknown): unknown {
  return v;
}

/** Chuyển mảng FortuneSheet Sheet[] → ArrayBuffer xlsx. */
function sheetsToXlsxArray(sheets: any[]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows: unknown[][] = [];
    const cd = sheet?.celldata as any[] | undefined;
    const data = sheet?.data as unknown[] | undefined;

    if (Array.isArray(cd) && cd.length > 0 && typeof cd[0] === "object" && "r" in cd[0]) {
      // Định dạng celldata [{ r, c, v }]
      let maxR = 0;
      let maxC = 0;
      for (const c of cd) {
        maxR = Math.max(maxR, c.r);
        maxC = Math.max(maxC, c.c);
      }
      for (let r = 0; r <= maxR; r++) rows[r] = new Array(maxC + 1).fill(null);
      for (const c of cd) {
        rows[c.r][c.c] = cellValue(c.v);
      }
    } else if (Array.isArray(data)) {
      // Định dạng ma trận 2D [[Cell, ...], ...]
      data.forEach((row, r) => {
        rows[r] = (row as any[]).map((cell) => (cell ? cellValue(cell.v) : null));
      });
    }

    const ws = XLSX.utils.aoa_to_sheet(rows as any[][]);
    XLSX.utils.book_append_sheet(wb, ws, String(sheet?.name || "Sheet1"));
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as unknown as ArrayBuffer;
}

// ── Component ──

export function ExcelEditor({
  itemId,
  session,
  onBack,
}: {
  itemId: string;
  session: AuthSession;
  onBack: () => void;
}) {
  const [sheetData, setSheetData] = useState<any[]>([{ name: "Sheet1" }]);
  const [readOnly, setReadOnly] = useState(true);
  const [history, setHistory] = useState<DriveFileVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const workbookRef = useRef<WorkbookInstance>(null);

  // Nạp file + bật gác cổng P2P Validation cho item đang mở.
  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        const handle = await driveService.getItemHandle(itemId);
        if (!handle || !handle.docSync()) {
          if (!disposed) setError("Không tải được file.");
          return;
        }
        const item = handle.docSync()!;
        setReadOnly(!accessService.canPerform(item, session.userId, "WRITE"));

        const raw = await driveService.openFile(item, session);
        if (disposed) return;

        const file = new File([raw as unknown as BlobPart], "data.xlsx");
        LuckyExcel.transformExcelToLucky(file, (data: any) => {
          if (disposed) return;
          const sheets = data?.sheets && data.sheets.length ? data.sheets : [{ name: "Sheet1" }];
          setSheetData(sheets);
          setLoading(false);
        });

        // Gác cổng 24/7: cảnh báo nếu doc bị can thiệp trái phép.
        const unsub = accessService.setupP2PValidation(handle);
        return () => {
          disposed = true;
          unsub();
        };
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : "Không mở được file.");
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [itemId, session]);

  // Lịch sử phiên bản (mới nhất lên đầu).
  const loadHistory = useCallback(async () => {
    const handle = await driveService.getItemHandle(itemId);
    if (!handle) return;
    setHistory(versionService.getFileHistory(handle).reverse());
    setShowHistory(true);
  }, [itemId]);

  // Lưu nội dung đã sửa.
  const saveFile = useCallback(async () => {
    const sheets = workbookRef.current?.getAllSheets();
    if (!sheets) return;
    setSaving(true);
    try {
      const arr = sheetsToXlsxArray(sheets);
      const handle = await driveService.getItemHandle(itemId);
      if (!handle) throw new Error("File không tồn tại.");
      await driveService.saveFileContent(handle, new Uint8Array(arr), session);
      alert("✅ Đã lưu thay đổi.");
    } catch (e) {
      alert("❌ Lỗi lưu: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }, [itemId, session]);

  // Khôi phục / xem một phiên bản (preview metadata).
  const restoreVersion = useCallback(
    async (hash: string) => {
      const handle = await driveService.getItemHandle(itemId);
      if (!handle) return;
      try {
        const doc = versionService.viewHistoricalVersion(handle, hash);
        alert(
          `Đã khôi phục metadata về phiên bản:\n${new Date(doc.updatedAt).toLocaleString()}\n` +
            `(Preview phiên bản — nội dung Excel thô sẽ được nạp khi lưu.)`,
        );
      } catch (e) {
        alert("Lỗi: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    [itemId],
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "8px 16px",
          background: "#f5f5f5",
          display: "flex",
          gap: 12,
          alignItems: "center",
          borderBottom: "1px solid #ddd",
        }}
      >
        <button onClick={onBack} className="btn-secondary">
          ← Về Drive
        </button>
        <button onClick={saveFile} className="btn-secondary" disabled={readOnly || saving}>
          {saving ? "Đang lưu…" : "💾 Lưu"}
        </button>
        <button onClick={loadHistory} className="btn-secondary">
          📜 Lịch sử phiên bản
        </button>
        <span style={{ fontSize: 13, color: readOnly ? "#b45309" : "#15803d" }}>
          {readOnly ? "🔒 Xem chỉ đọc (Viewer)" : "✏️ Đang chỉnh sửa"}
        </span>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {error ? (
            <p style={{ padding: 16, color: "#b91c1c" }}>{error}</p>
          ) : loading ? (
            <p style={{ padding: 16 }}>⏳ Đang mở bảng tính…</p>
          ) : (
            <Workbook
              ref={workbookRef}
              data={sheetData}
              allowEdit={!readOnly}
              showToolbar={!readOnly}
              showFormulaBar={!readOnly}
            />
          )}
        </div>

        {showHistory && (
          <div
            style={{
              width: 300,
              borderLeft: "1px solid #ccc",
              padding: 12,
              overflowY: "auto",
              background: "#fff",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Lịch sử thay đổi</h3>
              <button onClick={() => setShowHistory(false)} className="btn-secondary">
                Đóng
              </button>
            </div>
            {history.length === 0 && <p style={{ fontSize: 13 }}>Chưa có phiên bản nào.</p>}
            <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
              {history.map((ver) => (
                <li key={ver.commitHash} style={{ borderBottom: "1px solid #eee", padding: "8px 0" }}>
                  <div>
                    <b>{new Date(ver.timestamp).toLocaleString()}</b>
                  </div>
                  <small>
                    Người sửa: {ver.actorId.slice(0, 8)}… · {ver.message}
                  </small>
                  <br />
                  <button
                    onClick={() => restoreVersion(ver.commitHash)}
                    style={{ marginTop: 4, cursor: "pointer", fontSize: 12 }}
                  >
                    Xem / Khôi phục bản này
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
