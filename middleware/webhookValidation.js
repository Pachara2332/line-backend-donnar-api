const { createHmac, timingSafeEqual } = require('node:crypto');

function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !channelSecret) {
    return false;
  }

  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  return received.length === expected.length && timingSafeEqual(received, expected);
}

function createLineSignatureMiddleware(channelSecret) {
  return function validateLineSignature(req, res, next) {
    const signature = req.get('x-line-signature');
    if (!verifyLineSignature(req.body, signature, channelSecret)) {
      return res.status(401).json({ error: 'Invalid LINE signature' });
    }
    next();
  };
}

module.exports = { verifyLineSignature, createLineSignatureMiddleware };
