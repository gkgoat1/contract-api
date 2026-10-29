import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** Svelte config for the deploy-kit components (no SvelteKit; plain vite). */
export default {
  preprocess: vitePreprocess(),
};
