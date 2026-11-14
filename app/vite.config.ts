import { defineConfig } from "vite";

// Static build for GitHub Pages (relative paths, hash routing). Two pages: the app and the presentation.
export default defineConfig({
  base: "./",
  build: {
    outDir: "../docs",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: "index.html", slides: "slides.html" } },
  },
});
