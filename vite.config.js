import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Registration happens in src/main.jsx (virtual:pwa-register) so the app
      // can show "A new version is available" and let the user pick when to
      // reload; "auto" detects that import and injects nothing extra.
      injectRegister: "auto",
      registerType: "prompt",
      includeAssets: ["icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Load MS / RPE Tracker",
        short_name: "Load MS",
        description: "A local RPE-based workout tracker for training, readiness, and progression.",
        theme_color: "#111111",
        background_color: "#111111",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        // No skipWaiting / clientsClaim: with the prompt flow the new worker
        // must stay waiting until the banner's Reload posts SKIP_WAITING
        // (updateServiceWorker(true)); skipWaiting would activate it
        // immediately and the prompt would never be shown.
        navigateFallback: "index.html",
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
});
