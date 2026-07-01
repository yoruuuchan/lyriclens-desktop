import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // 5173 is vite's default. We used to sit on 1420 (the Tauri
    // scaffold's suggestion) but Windows dynamically reserves
    // ranges around it for Hyper-V / WSL NAT once those services
    // are enabled — a `tauri dev` boot then errors out with
    // `EACCES: permission denied 127.0.0.1:1420` even though
    // netstat shows nothing on the port. 5173 sits outside every
    // range Windows currently reserves on this box, and matches
    // what most Vite tutorials assume.
    port: 5173,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
