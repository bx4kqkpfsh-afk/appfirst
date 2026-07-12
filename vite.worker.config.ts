import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/server",
    emptyOutDir: true,
    lib: {
      entry: "worker/spa-worker.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: { external: [] },
  },
});
