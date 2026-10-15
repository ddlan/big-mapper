import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  // GitHub Pages serves the site at /big-mapper/ (and `vite preview` mirrors that); dev stays at the root.
  base: command === "build" || isPreview ? "/big-mapper/" : "/",
  // MapLibre 6 ships ESM that loads its tile worker by relative URL; prebundling breaks that.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  worker: { format: "es" },
}));
