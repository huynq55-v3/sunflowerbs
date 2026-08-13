import { useEffect, useState } from "react";
import { Register } from "@/components/Register";
import { Login } from "@/components/Login";
import { Account } from "@/components/Account";
import { getSession, logout, restoreSession } from "@/services/authService";

type Tab = "login" | "register";

export default function App() {
  const [user, setUser] = useState<string | null>(() => getSession()?.username ?? null);
  const [tab, setTab] = useState<Tab>("login");
  const [cryptoReady, setCryptoReady] = useState(false);

  // Nạp WASM crypto khi mở app.
  useEffect(() => {
    import("@/crypto/wasm")
      .then((m) => m.getCrypto())
      .then(() => setCryptoReady(true))
      .catch((e) => console.error("WASM not loaded. Chạy: npm run crypto:build", e));
  }, []);

  // Khôi phục phiên sau F5 (sessionStorage) — không cần nhập lại mật khẩu.
  useEffect(() => {
    restoreSession().then((s) => {
      if (s) setUser(s.username);
    });
  }, []);

  // Đã đăng nhập → bảng điều khiển tài khoản (tầng dữ liệu app sẽ thêm sau).
  if (user) {
    return (
      <Account
        username={user}
        onLogout={() => {
          logout();
          setUser(null);
          setTab("login");
        }}
      />
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">🌻 SunflowerBS</div>
        <p className="tagline">Workspace riêng tư · mã hóa đầu cuối · bạn giữ chìa khóa</p>

        <div className="tabs" role="tablist">
          {(
            [
              ["login", "Đăng nhập"],
              ["register", "Đăng ký"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "tab active" : "tab"}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {!cryptoReady && (
          <p className="hint">
            ⏳ Đang tải engine mã hóa… (nếu lỗi: chạy <code>npm run crypto:build</code>)
          </p>
        )}

        {tab === "login" && <Login onAuthed={setUser} />}
        {tab === "register" && <Register />}
      </div>
    </div>
  );
}
