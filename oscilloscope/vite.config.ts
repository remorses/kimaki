// Standalone React Server Components instrument demo.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import spiceflow from "spiceflow/vite";

export default defineConfig({
  plugins: [spiceflow({ entry: "./src/main.tsx" }), react(), tailwindcss()],
  server: {
    port: 5294,
    strictPort: true,
    allowedHosts: [".traforo.dev", ".kimaki.dev"],
  },
});
