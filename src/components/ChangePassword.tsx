import { useState } from "react";
import { changePassword, validatePassword } from "@/services/authService";

/**
 * Màn hình Đổi mật khẩu.
 * Dùng mật khẩu cũ + salt cũ giải mã seed (Private Key), sinh salt + master key
 * mới, mã hóa LẠI cùng seed gốc (không đổi) → cập nhật IndexedDB.
 * Toàn bộ dữ liệu đã phân quyền KHÔNG bị ảnh hưởng.
 */
export function ChangePassword({ username }: { username: string }) {
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (newPwd !== confirm) {
      return setMsg({ kind: "err", text: "Mật khẩu mới xác nhận không khớp." });
    }
    setBusy(true);
    try {
      await changePassword(username, oldPwd, newPwd);
      setMsg({
        kind: "ok",
        text: "Đổi mật khẩu thành công. Seed (Private Key) không đổi → dữ liệu cũ vẫn truy cập bình thường.",
      });
      setOldPwd("");
      setNewPwd("");
      setConfirm("");
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const pwErr = validatePassword(newPwd);

  return (
    <form className="form" onSubmit={submit}>
      <h3 style={{ margin: "0 0 4px" }}>Đổi mật khẩu</h3>
      <p className="form-note" style={{ margin: "0 0 8px" }}>
        Tài khoản: <code>{username}</code>
      </p>

      <label className="field">
        <span>Mật khẩu cũ</span>
        <input
          type="password"
          value={oldPwd}
          onChange={(e) => setOldPwd(e.target.value)}
          autoComplete="current-password"
        />
      </label>

      <label className="field">
        <span>Mật khẩu mới</span>
        <input
          type="password"
          value={newPwd}
          onChange={(e) => setNewPwd(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      {pwErr && <p className="hint">{pwErr}</p>}

      <label className="field">
        <span>Xác nhận mật khẩu mới</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      <button type="submit" className="btn-primary" disabled={busy || !!pwErr || newPwd !== confirm}>
        {busy ? "Đang xử lý…" : "Đổi mật khẩu"}
      </button>

      {msg && <p className={`msg ${msg.kind}`}>{msg.text}</p>}
    </form>
  );
}
