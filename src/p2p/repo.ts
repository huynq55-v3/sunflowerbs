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
import type { DocHandle } from "@automerge/automerge-repo";
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
 * `idFactory` chỉ được gọi trong lúc `create2()` — nó gán id CỐ ĐỊNH theo `kind`
 * mà `createFixedIdDoc()` đặt ngay trước lời gọi (Directory, Drive Index).
 * Mọi doc dữ liệu (Excel...) phải dùng `createDocument()` (sinh id ngẫu nhiên),
 * KHÔNG dùng `create2`, để tránh trùng id với các doc cố định. Xem bên dưới.
 */
export function getRepo(): Repo {
  if (!repo) {
    repo = new Repo({
      // Id cố định được quyết định bởi `pendingCreateKind` (do createFixedIdDoc set).
      idFactory: async () => docBinaryId(pendingCreateKind),
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
 * `kind` mà `idFactory` sẽ dùng khi `create2()` được gọi.
 * Mặc định là directory — chỉ đổi tạm trong `createFixedIdDoc`.
 */
let pendingCreateKind = "directory";

/**
 * Serialize các lời gọi tạo doc id cố định, tránh race khi `idFactory` đọc
 * `pendingCreateKind` (2 lời gọi `create2` đồng thời sẽ làm sai id).
 */
let createQueue: Promise<unknown> = Promise.resolve();

/**
 * Tạo một document tại id CỐ ĐỊNH theo `kind` (bootstrap máy đầu tiên).
 * Các lời gọi được xếp hàng tuần tự để `idFactory` luôn nhìn đúng kind.
 */
function createFixedIdDoc<T>(kind: string, initial: T): Promise<DocHandle<T>> {
  const run = async (): Promise<DocHandle<T>> => {
    pendingCreateKind = kind;
    try {
      return await getRepo().create2<T>(initial);
    } finally {
      pendingCreateKind = "directory"; // reset về mặc định
    }
  };
  const p = createQueue.then(run, run);
  createQueue = p;
  return p as Promise<DocHandle<T>>;
}

/**
 * Tạo document chia sẻ tại id CỐ ĐỊNH của Directory (máy đầu tiên bootstrap).
 * ⚠️ CHỈ dùng cho Directory.
 */
export function createDirectoryDoc<T>(initial: T) {
  return createFixedIdDoc("directory", initial);
}

/**
 * Tạo document chia sẻ tại id CỐ ĐỊNH của Drive Index (máy đầu tiên bootstrap).
 * ⚠️ CHỈ dùng cho Drive Index.
 */
export function createDriveIndexDoc<T>(initial: T) {
  return createFixedIdDoc("drive_index", initial);
}

/**
 * Tạo document dữ liệu với id NGẪU NHIÊN (dùng cho file Excel / doc phụ).
 * Không dùng `create2` để tránh trùng id với các doc cố định.
 */
export function createDocument<T>(initial?: T) {
  return getRepo().create<T>(initial);
}

/** Automerge URL của System_Users_Directory (cố định theo workspace). */
export async function getDirectoryUrl(): Promise<string> {
  return stringifyAutomergeUrl((await docBinaryId("directory")) as any);
}

/** Automerge URL của Drive Index (cố định theo workspace). */
export async function getDriveIndexUrl(): Promise<string> {
  return stringifyAutomergeUrl((await docBinaryId("drive_index")) as any);
}
