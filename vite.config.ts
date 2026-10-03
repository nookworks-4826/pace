import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { APP_NAME } from "./src/types/index.ts";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon-sunny.png"],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: "今使っていい金額を、いつでも。",
        lang: "ja",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "portrait-primary",
        theme_color: "#ffdf79",
        background_color: "#fafbf8",
        icons: [
          {
            src: "icon-sunny-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-sunny-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-sunny-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        importScripts: ['sw-notifications.js'],
        globIgnores: ['**/ocr/**'],
        runtimeCaching: [{
          urlPattern: ({url})=>url.origin===self.location.origin && /\/ocr\/(worker\.min\.js|tesseract-core-(?:relaxedsimd-|simd-)?lstm\.wasm\.js|(?:jpn|eng)\.traineddata\.gz)$/.test(url.pathname),
          handler:'CacheFirst',
          options:{cacheName:'pace-ocr-static-v7',expiration:{maxEntries:6},cacheableResponse:{statuses:[200]}},
        }],
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 5_000_000,
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
      },
    }),
  ],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  test: { environment: "node", include: ["src/tests/**/*.test.ts"] },
});
