import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // WASM crypto engine (wasm-pack --target web).
      // Build một lần bằng: npm run crypto:build
      "@crypto": fileURLToPath(new URL("./rust-crypto/pkg", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // Cho Vite biết xử lý file .wasm như asset tĩnh (tránh prebundle lỗi).
    exclude: ["@crypto"],
  },
  build: {
    target: "esnext",
  },
});
