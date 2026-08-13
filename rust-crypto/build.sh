#!/usr/bin/env bash
# Build Rust → WASM và đặt output vào rust-crypto/pkg (bundle ES module cho Vite).
set -euo pipefail
cd "$(dirname "$0")"

# wasm-pack: https://rustwasm.github.io/wasm-pack/installer/
wasm-pack build --target web --out-dir pkg "$@"

echo ""
echo "✅ Đã build xong: rust-crypto/pkg/sunflower_crypto.js (+ .wasm)"
echo "   Frontend import qua alias '@crypto' (xem vite.config.ts)."
