//! # Drive — Giao diện quản lý File/Folder P2P (cây thư mục)
//!
//! Render cây thư mục từ `driveService.listItems()`, breadcrumb dẫn đường, và
//! các thao tác: Tạo Folder, Upload File, Rename, Move, Trash/Restore, Delete,
//! Share (grant/revoke/transfer). Mọi nút tự ẩn/hiện theo `canPerform`.
//!
//! Mỗi lần vào folder, resolve doc của từng item để lấy tên (giải mã) + ACL
//! (để gác quyền). Gác cổng P2P Validation được nhúng ở `ExcelEditor` khi mở file.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DocHandle } from "@automerge/automerge-repo";
import { driveService } from "@/services/driveService";
import { accessService } from "@/services/accessService";
import { subscribeDirectory, type DirectoryEntry } from "@/services/directoryService";
import type { AuthSession } from "@/services/authService";
import type { DriveItemRecord, ShareRole } from "@/types/drive";
import type { IndexEntry } from "@/types/driveIndex";

/** Item đã resolve: index (công khai) + record (ACL) + tên rõ. */
interface DriveViewItem {
  index: IndexEntry;
  record: DriveItemRecord;
  handle: DocHandle<DriveItemRecord>;
  name: string;
}

/** Mục breadcrumb. */
interface Crumb {
  id: string | null;
  name: string;
}

export function Drive({
  session,
  onLogout,
  onOpenFile,
}: {
  session: AuthSession;
  onLogout: () => void;
  onOpenFile: (itemId: string) => void;
}) {
  const [parentId, setParentId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: "My Drive" }]);
  const [items, setItems] = useState<DriveViewItem[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const [moveTarget, setMoveTarget] = useState<DriveViewItem | null>(null);
  const [shareTarget, setShareTarget] = useState<DriveViewItem | null>(null);
  const [allFolders, setAllFolders] = useState<IndexEntry[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  };

  /** Đi vào một folder. */
  const openFolder = useCallback(
    async (entry: IndexEntry, name: string) => {
      setParentId(entry.id);
      const last = crumbs[crumbs.length - 1];
      setCrumbs((c) => (last?.id === entry.id ? c : [...c, { id: entry.id, name }]));
    },
    [crumbs],
  );

  /** Làm mới danh sách của folder hiện tại. */
  const refresh = useCallback(
    async (targetParent = parentId) => {
      setLoading(true);
      try {
        const entries = await driveService.listItems(targetParent, showTrash);
        const view: DriveViewItem[] = [];
        for (const e of entries) {
          const handle = await driveService.getItemHandle(e.id);
          const rec = handle?.docSync();
          if (!handle || !rec) continue;
          let name = "(không có quyền)";
          try {
            name = await driveService.getItemName(rec, session);
          } catch {
            // không đọc được tên → giữ placeholder
          }
          view.push({ index: e, record: rec, handle, name });
        }
        view.sort((a, b) => {
          if (a.record.type !== b.record.type) return a.record.type === "FOLDER" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setItems(view);
      } catch (e) {
        flash("Lỗi tải danh sách: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    },
    [parentId, showTrash, session],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Breadcrumb ──
  const navTo = (crumb: Crumb) => {
    const idx = crumbs.findIndex((c) => c.id === crumb.id);
    setCrumbs(crumbs.slice(0, idx + 1));
    setParentId(crumb.id);
  };

  // ── Tạo Folder ──
  const newFolder = async () => {
    const name = window.prompt("Tên thư mục mới:", "Folder mới");
    if (!name || !name.trim()) return;
    try {
      await driveService.createItem({ name, type: "FOLDER", parentId, session });
      flash("✅ Đã tạo thư mục.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ── Upload File ──
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      await driveService.createItem({
        name: file.name.replace(/\.xlsx?$/i, "") || "Sheet",
        type: "FILE",
        parentId,
        content: buf,
        session,
      });
      flash("✅ Đã upload: " + file.name);
      void refresh();
    } catch (err) {
      flash("❌ Upload lỗi: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  // ── Rename ──
  const renameItem = async (item: DriveViewItem) => {
    const newName = window.prompt("Tên mới:", item.name);
    if (!newName || !newName.trim()) return;
    try {
      await driveService.renameItem(item.handle, newName, session);
      flash("✅ Đã đổi tên.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ── Thùng rác / Khôi phục ──
  const trashItem = async (item: DriveViewItem) => {
    try {
      await driveService.setTrashState(item.handle, true, session);
      flash("🗑 Đã chuyển vào thùng rác.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const restoreItem = async (item: DriveViewItem) => {
    try {
      await driveService.setTrashState(item.handle, false, session);
      flash("♻️ Đã khôi phục.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ── Xóa vĩnh viễn ──
  const deletePermanent = async (item: DriveViewItem) => {
    if (!window.confirm(`Xóa vĩnh viễn "${item.name}"? (không thể hoàn tác)`)) return;
    try {
      await driveService.deletePermanently(item.handle, session);
      flash("🗑 Đã xóa vĩnh viễn.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ── Mở file (Excel) ──
  const openFile = (item: DriveViewItem) => {
    if (item.record.type === "FOLDER") {
      void openFolder(item.index, item.name);
      return;
    }
    onOpenFile(item.index.id);
  };

  // ── Mở Modal Move: thu thập toàn bộ folder làm đích ──
  const openMove = async (item: DriveViewItem) => {
    const acc: IndexEntry[] = [];
    const walk = async (p: string | null) => {
      for (const e of await driveService.listItems(p)) {
        if (e.type === "FOLDER" && e.id !== item.index.id) {
          acc.push(e);
          await walk(e.id);
        }
      }
    };
    await walk(null);
    setAllFolders(acc);
    setMoveTarget(item);
  };
  const doMove = async (newParentId: string) => {
    if (!moveTarget) return;
    try {
      await driveService.moveItem(moveTarget.handle, newParentId === "root" ? null : newParentId, session);
      flash("📁 Đã di chuyển.");
      setMoveTarget(null);
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // ── Modal Share ──
  const [dirUsers, setDirUsers] = useState<Record<string, DirectoryEntry>>({});
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void subscribeDirectory((u) => setDirUsers(u)).then((fn) => (unsub = fn));
    return () => unsub?.();
  }, []);

  const grant = async (userId: string, role: ShareRole) => {
    if (!shareTarget) return;
    try {
      await accessService.grantAccess({
        itemHandle: shareTarget.handle,
        targetUserId: userId,
        role,
        currentUser: session,
      });
      flash("🔑 Đã cấp quyền.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const revoke = async (userId: string) => {
    if (!shareTarget) return;
    try {
      await driveService.revokeAndReEncrypt({
        itemHandle: shareTarget.handle,
        targetUserId: userId,
        currentUser: session,
      });
      flash("🚫 Đã thu hồi + đổi ổ khóa.");
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };
  const transfer = async (userId: string) => {
    if (!shareTarget) return;
    try {
      await accessService.transferOwnership({
        itemHandle: shareTarget.handle,
        newOwnerId: userId,
        currentUser: session,
      });
      flash("🔄 Đã chuyển quyền sở hữu.");
      setShareTarget(null);
      void refresh();
    } catch (e) {
      flash("❌ " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const isOwner = (item: DriveViewItem) =>
    accessService.canPerform(item.record, session.userId, "SHARE");

  const sharedUsers = shareTarget
    ? Object.entries(shareTarget.record.accessList).filter(([uid]) => uid !== session.userId)
    : [];
  const grantableUsers = Object.entries(dirUsers).filter(
    ([uid]) => uid !== session.userId && !shareTarget?.record.accessList[uid],
  );

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 860, width: "100%" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <div className="brand">🌻 SunflowerBS</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="tagline" style={{ margin: 0 }}>
              <b>{session.username}</b>
            </span>
            <button className="btn-secondary" onClick={onLogout}>
              Đăng xuất
            </button>
          </div>
        </div>

        {notice && <p className="msg ok">{notice}</p>}

        {/* Toolbar */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <button className="btn-secondary" onClick={newFolder}>
            📁 Folder mới
          </button>
          <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
            ⬆️ Upload File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: "none" }}
            onChange={onUpload}
          />
          <button className="btn-secondary" onClick={() => void refresh()}>
            🔄 Làm mới
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              setShowTrash((v) => !v);
            }}
          >
            {showTrash ? "📁 Xem Drive" : "🗑 Thùng rác"}
          </button>
        </div>

        {/* Breadcrumb */}
        <div style={{ margin: "8px 0", fontSize: 14 }}>
          {crumbs.map((c, i) => (
            <span key={c.id ?? "root"}>
              {i > 0 && <span style={{ margin: "0 4px" }}>/</span>}
              <button
                onClick={() => navTo(c)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#1d4ed8",
                  cursor: "pointer",
                  fontWeight: i === crumbs.length - 1 ? "bold" : "normal",
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>

        {/* Danh sách */}
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "flex", background: "#f9fafb", padding: "8px 12px", fontWeight: 600 }}>
            <div style={{ flex: 1 }}>Tên</div>
            <div style={{ width: 90 }}>Loại</div>
            <div style={{ width: 220, textAlign: "right" }}>Thao tác</div>
          </div>

          {loading && <p style={{ padding: 16 }}>⏳ Đang tải…</p>}
          {!loading && items.length === 0 && (
            <p style={{ padding: 16, color: "#6b7280" }}>Thư mục trống.</p>
          )}

          {items.map((item) => {
            const canWrite = accessService.canPerform(item.record, session.userId, "WRITE");
            const canMove = accessService.canPerform(item.record, session.userId, "REMOVE_FROM_FOLDER");
            const canDelete = accessService.canPerform(item.record, session.userId, "DELETE_PERMANENTLY");
            const canShare = accessService.canPerform(item.record, session.userId, "SHARE");
            return (
              <div
                key={item.index.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 12px",
                  borderTop: "1px solid #f3f4f6",
                }}
              >
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{item.record.type === "FOLDER" ? "📁" : "📄"}</span>
                  <button
                    onClick={() => openFile(item)}
                    style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                    title="Mở"
                  >
                    <b>{item.name}</b>
                  </button>
                </div>
                <div style={{ width: 90, fontSize: 13, color: "#6b7280" }}>
                  {item.record.type === "FOLDER" ? "Folder" : "Excel"}
                </div>
                <div style={{ width: 220, textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {canWrite && !showTrash && (
                    <button className="btn-secondary" onClick={() => renameItem(item)}>
                      Đổi tên
                    </button>
                  )}
                  {canMove && !showTrash && (
                    <button className="btn-secondary" onClick={() => void openMove(item)}>
                      Di chuyển
                    </button>
                  )}
                  {canShare && !showTrash && (
                    <button className="btn-secondary" onClick={() => setShareTarget(item)}>
                      Chia sẻ
                    </button>
                  )}
                  {canWrite && !showTrash && (
                    <button className="btn-secondary" onClick={() => trashItem(item)}>
                      Thùng rác
                    </button>
                  )}
                  {canWrite && showTrash && (
                    <button className="btn-secondary" onClick={() => restoreItem(item)}>
                      Khôi phục
                    </button>
                  )}
                  {canDelete && (
                    <button className="btn-secondary" onClick={() => deletePermanent(item)}>
                      Xóa
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal Di chuyển */}
      {moveTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setMoveTarget(null)}
        >
          <div
            className="auth-card"
            style={{ maxWidth: 420, width: "100%", position: "relative" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Di chuyển "{moveTarget.name}"</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button className="btn-secondary" onClick={() => doMove("root")}>
                📁 My Drive (gốc)
              </button>
              {allFolders.map((f) => (
                <button key={f.id} className="btn-secondary" onClick={() => doMove(f.id)}>
                  📁 {f.id.slice(0, 8)}…
                </button>
              ))}
              {allFolders.length === 0 && (
                <p style={{ fontSize: 13, color: "#6b7280" }}>Không có folder nào khác.</p>
              )}
            </div>
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button className="btn-secondary" onClick={() => setMoveTarget(null)}>
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Chia sẻ */}
      {shareTarget && isOwner(shareTarget) && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShareTarget(null)}
        >
          <div
            className="auth-card"
            style={{ maxWidth: 480, width: "100%", position: "relative" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Chia sẻ "{shareTarget.name}"</h3>

            <h4 style={{ marginBottom: 4 }}>Đang chia sẻ với:</h4>
            {sharedUsers.length === 0 && (
              <p style={{ fontSize: 13, color: "#6b7280" }}>Chưa chia sẻ với ai.</p>
            )}
            {sharedUsers.map(([uid, acc]) => (
              <div
                key={uid}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 0",
                  borderBottom: "1px solid #eee",
                }}
              >
                <span style={{ fontSize: 14 }}>
                  {dirUsers[uid]?.username ?? uid.slice(0, 8)}…{" "}
                  <b style={{ color: "#6b7280" }}>({acc.role})</b>
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="btn-secondary"
                    onClick={() => grant(uid, acc.role === "EDITOR" ? "VIEWER" : "EDITOR")}
                  >
                    {acc.role === "EDITOR" ? "→ Viewer" : "→ Editor"}
                  </button>
                  <button className="btn-secondary" onClick={() => revoke(uid)}>
                    Thu hồi
                  </button>
                </div>
              </div>
            ))}

            <h4 style={{ marginBottom: 4, marginTop: 12 }}>Cấp quyền mới:</h4>
            {grantableUsers.length === 0 && (
              <p style={{ fontSize: 13, color: "#6b7280" }}>Không có người dùng nào khác trong workspace.</p>
            )}
            {grantableUsers.map(([uid, u]) => (
              <div
                key={uid}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "4px 0",
                }}
              >
                <span style={{ fontSize: 14 }}>{u.username}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="btn-secondary" onClick={() => grant(uid, "VIEWER")}>
                    + Viewer
                  </button>
                  <button className="btn-secondary" onClick={() => grant(uid, "EDITOR")}>
                    + Editor
                  </button>
                </div>
              </div>
            ))}

            <h4 style={{ marginBottom: 4, marginTop: 12 }}>Chuyển quyền sở hữu:</h4>
            {Object.entries(dirUsers)
              .filter(([uid]) => uid !== session.userId)
              .map(([uid, u]) => (
                <div
                  key={uid}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "4px 0",
                  }}
                >
                  <span style={{ fontSize: 14 }}>{u.username}</span>
                  <button
                    className="btn-secondary"
                    onClick={() => window.confirm(`Chuyển quyền sở hữu cho ${u.username}?`) && transfer(uid)}
                  >
                    Chuyển
                  </button>
                </div>
              ))}

            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button className="btn-secondary" onClick={() => setShareTarget(null)}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
