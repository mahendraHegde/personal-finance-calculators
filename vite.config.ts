import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  base: "/personal-finance-calculators/",
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    allowedHosts: [".srv.us"],
  },
});
