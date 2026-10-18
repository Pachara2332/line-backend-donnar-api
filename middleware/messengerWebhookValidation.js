const { createHmac, timingSafeEqual } = require('node:crypto');

function createMessengerSignatureMiddleware(appSecret) {
  return function messengerSignatureMiddleware(req, res, next) {
    const signature = req.get('x-hub-signature-256') || '';
    const match = /^sha256=([a-f0-9]{64})$/i.exec(signature);
    if (!appSecret || !Buffer.isBuffer(req.body) || !match) return res.sendStatus(401);
    const expected = createHmac('sha256', appSecret).update(req.body).digest();
    const supplied = Buffer.from(match[1], 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return res.sendStatus(401);
    return next();
  };
}

module.exports = { createMessengerSignatureMiddleware };
