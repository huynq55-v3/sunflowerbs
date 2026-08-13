import { useState } from "react";
import { register, validatePassword } from "@/services/authService";

const RULES: { id: string; label: string; ok: (pw: string) => boolean }[] = [
  { id: "len", label: "Ít nhất 12 ký tự", ok: (p) => p.length >= 12 },
  { id: "upper", label: "Có chữ HOA (A-Z)", ok: (p) => /[A-Z]/.test(p) },
  { id: "lower", label: "Có chữ thường (a-z)", ok: (p) => /[a-z]/.test(p) },
  { id: "digit", label: "Có chữ số (0-9)", ok: (p) => /[0-9]/.test(p) },
  { id: "special", label: "Có ký tự đặc biệt (!@#$…)", ok: (p) => /[^A-Za-z0-9]/.test(p) },
];

/** Màn hình Đăng ký (self-registration, không cần admin duyệt). */
export function Register() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (password !== confirm) {
      return setMsg({ kind: "err", text: "Mật khẩu xác nhận không khớp." });
    }
    setBusy(true);
    try {
      const payload = await register(username, password);
      setMsg({
        kind: "ok",
        text:
          `Tài khoản "${payload.username}" đã tạo. Vault đã đồng bộ lên mạng P2P — ` +
          `bạn có thể gõ Username + Password trên máy khác để đăng nhập ngay.`,
      });
      setPassword("");
      setConfirm("");
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const pwError = validatePassword(password);

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
          autoComplete="new-password"
        />
      </label>

      <div className="pw-rules">
        {RULES.map((r) => {
          const done = r.ok(password);
          return (
            <span key={r.id} className={done ? "rule done" : "rule"}>
              {done ? "✓" : "○"} {r.label}
            </span>
          );
        })}
      </div>

      <label className="field">
        <span>Xác nhận mật khẩu</span>
        <input
          placeholder="Nhập lại mật khẩu"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      <button
        type="submit"
        className="btn-primary"
        disabled={busy || !!pwError || password !== confirm}
      >
        {busy ? "Đang xử lý…" : "Đăng ký"}
      </button>

      <p className="form-note">
        Mật khẩu <b>không bao giờ được lưu</b> (máy bạn hay mạng P2P đều không có).
        Vault chứa seed đã mã hóa — lưu ở máy bạn và đồng bộ P2P; muốn mở phải có
        mật khẩu, bảo vệ bằng Argon2id siêu nặng.
      </p>

      {msg && <p className={`msg ${msg.kind}`}>{msg.text}</p>}
    </form>
  );
}
