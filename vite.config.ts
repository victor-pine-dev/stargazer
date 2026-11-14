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
    .catch((err) => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Unable to reach open ADS-B providers.',
        }),
      );
    });
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
  plugins: [stargazerAdsbProxyPlugin()],
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
