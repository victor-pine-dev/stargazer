import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const { parseQueryParams, fetchNormalizedAdsb } = require('./api/shared/adsbProxy.cjs') as {
  parseQueryParams: (
    latInput: string | null,
    lonInput: string | null,
    radiusInput: string | null,
  ) => { lat: number; lon: number; radius: number; error?: undefined } | { error: string };
  fetchNormalizedAdsb: (
    lat: number,
    lon: number,
    radiusNm: number,
  ) => Promise<{ source: string; fetchedAtMs: number; aircraft: unknown[] }>;
};

function handleAircraftProxyMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const reqUrl = req.url ?? '';
  if (!reqUrl.startsWith('/api/aircraft')) {
    next();
    return;
  }

  const url = new URL(reqUrl, 'http://localhost');
  const parsed = parseQueryParams(
    url.searchParams.get('lat'),
    url.searchParams.get('lon'),
    url.searchParams.get('radius'),
  );

  if ('error' in parsed) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: parsed.error }));
    return;
  }

  void fetchNormalizedAdsb(parsed.lat, parsed.lon, parsed.radius)
    .then((payload) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=4');
      res.end(JSON.stringify(payload));
    })
    .catch(() => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: 'Unable to reach open ADS-B providers.',
        }),
      );
    });
}

const VIRTUAL_SAT_WASM_STUB = '\0virtual:satellite-wasm-stub';

function stripSatelliteWasmPlugin(): Plugin {
  return {
    name: 'strip-satellite-wasm',
    enforce: 'pre',
    resolveId(id, importer) {
      if (
        id === '#wasm-single-thread' ||
        id === '#wasm-multi-thread' ||
        (importer?.includes('satellite.js') &&
          (id === './wasm/index.js' || id.endsWith('/wasm/index.js')))
      ) {
        return VIRTUAL_SAT_WASM_STUB;
      }
      return null;
    },
    load(id) {
      if (id === VIRTUAL_SAT_WASM_STUB) {
        return 'export {};';
      }
      return null;
    },
  };
}

function stargazerAdsbProxyPlugin(): Plugin {
  return {
    name: 'stargazer-adsb-proxy',
    configureServer(server) {
      server.middlewares.use(handleAircraftProxyMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleAircraftProxyMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [stargazerAdsbProxyPlugin(), stripSatelliteWasmPlugin()],
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  worker: {
    format: 'es',
    plugins: () => [stripSatelliteWasmPlugin()],
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) {
            return 'vendor-three';
          }
          if (
            id.includes('node_modules/astronomy-engine') ||
            id.includes('node_modules/satellite.js')
          ) {
            return 'vendor-astro';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
