const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("node:path");

module.exports = defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4567",
    },
  },
});
