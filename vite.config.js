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
        // Covers every emitted chunk (vendor-react, vendor-icons and the
        // React.lazy chunks alike), so an installed PWA still launches
        // offline; verify-bundle-h4-precache.mjs asserts it on a build.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        // Decision H4-8: the retry of a failed lazy chunk imports the same
        // file with a `lazy-retry` query (src/lib/lazyPages.js); the precache
        // answers it like the plain URL. The first two are the workbox
        // defaults.
        ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^lazy-retry$/],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: {
    // Decision H4-5. The framework and the icon set change only when a
    // dependency is bumped, so they live in their own precached chunks: an app
    // release no longer re-downloads React, and the app chunk is what the UI
    // track's React.lazy boundaries split further. Vite 8 bundles with
    // rolldown, whose option is build.rolldownOptions (build.rollupOptions is
    // the deprecated alias) and whose manual chunking is codeSplitting.groups.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-icons",
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
    // Decision H4-11: just above the largest chunk measured after the lazy
    // boundaries (programStorage, 206 kB), so a chunk that grows warns.
    // verify-bundle-h4-precache.mjs fails when a chunk passes the limit or
    // when the limit is more than 15 % above the largest chunk.
    chunkSizeWarningLimit: 225,
  },
});
