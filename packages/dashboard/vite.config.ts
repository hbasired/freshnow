import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // The API serves this build under /app/ (see packages/api/src/routes/app-shell.ts), so
  // asset URLs must be rooted there too. With the default "/" the page loads and then
  // 404s on its own script — which is exactly what the first real-browser check found.
  base: "/app/",
  plugins: [react(), tailwindcss()],
  server: {
    // Bind on all interfaces so a phone on the same wifi can open it, matching how the
    // API is reached today.
    host: true,
    port: 5174,
    // The API is a separate origin in dev; proxying keeps the browser same-origin so no
    // CORS configuration is needed on the Fastify side.
    proxy: {
      "/dashboard": { target: "http://localhost:3001", changeOrigin: true },
      "/app-config": { target: "http://localhost:3001", changeOrigin: true },
      "/employees": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
