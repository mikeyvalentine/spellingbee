import { defineConfig } from "vite";

// Discord serves the Activity inside an iframe over HTTPS, usually via a tunnel
// (cloudflared / ngrok). `allowedHosts: true` lets those hostnames through in dev.
//
// Local dev backend: defaults to the Worker runtime (`npm run cf:dev`, :8788),
// which has the full feature set (per-call rooms + public matchmaking + DOs).
// Set VITE_DEV_BACKEND=http://localhost:3001 to use the simpler Node server
// (`npm run server`) instead — note it only serves a single global room.
const BACKEND = process.env.VITE_DEV_BACKEND || "http://127.0.0.1:8788";
const WS_BACKEND = BACKEND.replace(/^http/, "ws");

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: WS_BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: "es2020",
  },
});
