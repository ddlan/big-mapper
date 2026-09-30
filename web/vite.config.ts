import { defineConfig } from "vite";

export default defineConfig({
  // MapLibre 6 ships ESM that loads its tile worker by relative URL; prebundling breaks that.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
