import { useState } from "react";
import { login } from "@/services/authService";

/**
 * Màn hình Đăng nhập.
 * Máy này chưa có tài khoản → tự tải vault từ System_Users_Directory P2P
 * (gõ mật khẩu trên máy mới dùng được ngay).
 */
export function Login({ onAuthed }: { onAuthed: (name: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const s = await login(username, password);
      setMsg({ kind: "ok", text: `Đăng nhập thành công. Chào ${s.username} 👋` });
      onAuthed(s.username);
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Username</span>
        <input
          placeholder="Nhập tên đăng nhập"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />
      </label>

      <label className="field">
        <span>Mật khẩu</span>
        <input
          placeholder="Nhập mật khẩu"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>

      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "Đang xử lý…" : "Đăng nhập"}
      </button>

      <p className="form-note">
        Máy này chưa có tài khoản? Đăng ký mới, hoặc gõ đúng Username + Password
        — hệ thống tự kéo Vault của bạn về từ mạng P2P (cần relay hoặc thiết bị
        khác đang online).
      </p>

      {msg && <p className={`msg ${msg.kind}`}>{msg.text}</p>}
    </form>
  );
}
