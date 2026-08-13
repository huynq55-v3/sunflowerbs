import { useState } from "react";
import { ChangePassword } from "@/components/ChangePassword";

/**
 * Bảng điều khiển tài khoản (hiển thị sau khi đăng nhập).
 * Tầng dữ liệu của app (Excel...) sẽ được thêm vào đây sau.
 */
export function Account({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [section, setSection] = useState<"home" | "password">("home");

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <div className="brand">🌻 SunflowerBS</div>
        <p className="tagline">
          Đã đăng nhập: <b>{username}</b>
        </p>

        <div className="account-nav">
          <button className={section === "home" ? "tab active" : "tab"} onClick={() => setSection("home")}>
            Tổng quan
          </button>
          <button className={section === "password" ? "tab active" : "tab"} onClick={() => setSection("password")}>
            Đổi mật khẩu
          </button>
        </div>

        {section === "home" && (
          <div className="form">
            <p className="msg ok">
              ✅ Đăng nhập thành công. Bạn đang giữ chìa khóa (seed) của tài khoản trong RAM.
            </p>
            <p className="form-note">
              Đây là nơi app (xử lý Excel...) sẽ được gắn vào trong các bước tiếp theo.
              Toàn bộ dữ liệu của bạn được mã hóa bằng các khóa dẫn xuất từ seed này —
              chỉ bạn mới giải mã được.
            </p>
            <p className="form-note">
              🌐 Sang máy/trình duyệt khác: chỉ cần gõ <b>Username + Password</b>, hệ
              thống tự kéo Vault về từ mạng P2P (relay / thiết bị khác online).
            </p>
            <button type="button" className="btn-secondary" onClick={onLogout}>
              Đăng xuất
            </button>
          </div>
        )}

        {section === "password" && <ChangePassword username={username} />}
      </div>
    </div>
  );
}
