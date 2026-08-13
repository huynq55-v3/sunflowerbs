//! # P2P Repo (Automerge) — Hạ tầng đồng bộ chung cho toàn app.
//!
//! Một `Repo` Automerge duy nhất kết nối qua:
//!   - **BroadcastChannel**: đồng bộ giữa các tab của cùng trình duyệt.
//!   - **WebSocket → Relay**: đồng bộ chéo máy / trình duyệt (ws://localhost:4400).
//!   - **IndexedDB**: lưu bản local để offline.
//!
//! Document chia sẻ (Directory người dùng, dữ liệu Excel sau này) được đồng bộ
//! tự động giữa mọi thiết bị trong cùng workspace.

import { Repo, stringifyAutomergeUrl } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

/** Định danh workspace — mọi client cùng group chia sẻ cùng bộ document. */
const GROUP_ID: string = import.meta.env.VITE_GROUP_ID ?? "sunflower-workspace-01";

let repo: Repo | null = null;

/** Binary id (16 bytes) của document chia sẻ — cố định theo `kind` + workspace. */
let binaryIdCache = new Map<string, Promise<Uint8Array>>();
function docBinaryId(kind: string): Promise<Uint8Array> {
  let p = binaryIdCache.get(kind);
  if (!p) {
    p = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${kind}:${GROUP_ID}`),
      );
      return new Uint8Array(digest).slice(0, 16);
    })();
    binaryIdCache.set(kind, p);
  }
  return p;
}

/**
 * Singleton Repo.
 *
 * ⚠️ `idFactory` chỉ được dùng bởi `create2()` — nó gán id CỐ ĐỊNH (Directory)
 * cho việc tạo doc chia sẻ. Mọi doc dữ liệu sau này (Excel...) phải dùng
 * `createDocument()` (sinh id ngẫu nhiên), KHÔNG dùng `create2`, để tránh
 * trùng id với Directory. Xem comment mỗi hàm bên dưới.
 */
export function getRepo(): Repo {
  if (!repo) {
    repo = new Repo({
      // Chỉ Directory được tạo tại id cố định (via `create2` bên dưới).
      idFactory: async () => docBinaryId("directory"),
      network: [
        new BroadcastChannelNetworkAdapter(),
        new BrowserWebSocketClientAdapter(
          import.meta.env.VITE_SYNC_SERVER_URL ?? "ws://localhost:4400",
        ),
      ],
      storage: new IndexedDBStorageAdapter(),
    });
  }
  return repo;
}

/**
 * Tạo document chia sẻ tại id CỐ ĐỊNH của Directory (máy đầu tiên bootstrap).
 * ⚠️ CHỈ dùng cho Directory — các doc dữ liệu khác phải dùng `createDocument`.
 */
export function createDirectoryDoc<T>(initial: T) {
  return getRepo().create2<T>(initial);
}

/**
 * Tạo document dữ liệu với id NGẪU NHIÊN (dùng cho file Excel / doc phụ sau này).
 * Không dùng `create2` để tránh trùng id với Directory.
 */
export function createDocument<T>(initial: T) {
  return getRepo().create<T>(initial);
}

/** Automerge URL của System_Users_Directory (cố định theo workspace). */
export async function getDirectoryUrl(): Promise<string> {
  return stringifyAutomergeUrl((await docBinaryId("directory")) as any);
}
