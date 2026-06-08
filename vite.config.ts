import { defineConfig } from "vite";

// Discord serves the Activity inside an iframe over HTTPS, usually via a tunnel
// (cloudflared / ngrok). `allowedHosts: true` lets those hostnames through in dev.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    // Proxy the token-exchange endpoint + WebSocket relay to the local Node
    // server. Harmless in mock mode (the token route is just never called).
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2020",
  },
});
