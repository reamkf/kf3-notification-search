import type { NotFoundHandler } from 'hono';

const handler: NotFoundHandler = async (c) => {
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && c.env.ASSETS) {
    const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }
  }
  c.status(404);
  return c.render('404 Not Found');
};

export default handler;
