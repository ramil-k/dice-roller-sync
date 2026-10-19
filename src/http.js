// Small HTTP helpers shared by the route modules.

export const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Buffer a request body up to `limit` bytes; resolves null when it is larger
// (the socket is dropped - a client past the limit has nothing to wait for).
export const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

// A JSON object body (up to 16 KB), or null when it is missing, too large or
// not an object.
export const readJson = async (req) => {
  const buf = await readBody(req, 16 * 1024);
  if (!buf) return null;
  try {
    const value = JSON.parse(buf.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
