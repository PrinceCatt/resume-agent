import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = `http://127.0.0.1:${process.env.API_PORT ?? 8791}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5191),
    strictPort: true,
    // Keep the browser's Host header: the API only answers requests addressed to localhost.
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/fixtures": { target: API, changeOrigin: false },
    },
  },
  build: { outDir: "dist" },
});
