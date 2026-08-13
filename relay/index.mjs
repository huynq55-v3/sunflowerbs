// Relay WebSocket (Automerge) — "mạch máu" P2P cho toàn app.
// Đồng bộ Vault (đăng nhập mọi máy) + dữ liệu Excel (các phase sau).
//
// Chạy: `npm run relay`  →  ws://localhost:4400
import { WebSocketServer } from "ws";
import { Repo } from "@automerge/automerge-repo";
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket";

const port = Number(process.env.PORT || 4400);
const wss = new WebSocketServer({ port });
const repo = new Repo({ network: [new WebSocketServerAdapter(wss)] });

console.log(`🚀 Relay P2P đang chạy: ws://localhost:${port}`);
console.log("   Các thiết bị cùng VITE_GROUP_ID sẽ đồng bộ qua đây.");
