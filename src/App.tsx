import { useEffect, useState } from "react";
import { Register } from "@/components/Register";
import { Login } from "@/components/Login";
import { Drive } from "@/components/Drive";
import { ExcelEditor } from "@/components/ExcelEditor";
import { getSession, logout, restoreSession } from "@/services/authService";

type Tab = "login" | "register";

export default function App() {
  const [user, setUser] = useState<string | null>(() => getSession()?.username ?? null);
  const [tab, setTab] = useState<Tab>("login");
  const [cryptoReady, setCryptoReady] = useState(false);
  const [openFileId, setOpenFileId] = useState<string | null>(null);

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

  const handleLogout = () => {
    logout();
    setUser(null);
    setOpenFileId(null);
    setTab("login");
  };

  // Đã đăng nhập → workspace Drive / Excel Editor.
  if (user) {
    const session = getSession();
    if (!session) return null; // chờ session (thường không xảy ra)

    // Đang mở 1 file Excel.
    if (openFileId) {
      return (
        <ExcelEditor
          itemId={openFileId}
          session={session}
          onBack={() => setOpenFileId(null)}
        />
      );
    }

    return (
      <Drive
        session={session}
        onLogout={handleLogout}
        onOpenFile={(id) => setOpenFileId(id)}
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
