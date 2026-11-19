'use strict';

const { parseQueryParams, fetchNormalizedAdsb } = require('../shared/adsbProxy.cjs');

module.exports = async function (context, req) {
  const query = req && req.query ? req.query : {};
  const parsed = parseQueryParams(query.lat, query.lon, query.radius);

  if (parsed.error) {
    context.res = {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ error: parsed.error }),
    };
    return;
  }

  try {
    const result = await fetchNormalizedAdsb(parsed.lat, parsed.lon, parsed.radius);
    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=4',
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    if (context && context.log && typeof context.log.warn === 'function') {
      context.log.warn('ADS-B proxy upstream failure:', err);
    }
    context.res = {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        error: 'Unable to reach open ADS-B data providers.',
      }),
    };
  }
};
