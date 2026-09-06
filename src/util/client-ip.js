// Real visitor IP behind the Cloudflare tunnel.
//
// With the tunnel, the app receives connections from cloudflared on loopback, so
// req.ip is 127.0.0.1 for everyone and Cloudflare puts the true client IP in the
// CF-Connecting-IP header. We trust that header ONLY when the request's immediate
// peer is loopback — i.e. it really came through cloudflared. If the app is also
// reachable directly on the LAN (testing), a LAN client connecting from a non-loopback
// address could otherwise forge CF-Connecting-IP to evade rate limiting; for those we
// use req.ip (the real socket address) instead.
function isLoopbackPeer(req) {
  const peer = req.socket && req.socket.remoteAddress;
  return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}

function clientIp(req) {
  if (isLoopbackPeer(req)) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return Array.isArray(cf) ? cf[0] : String(cf).trim();
  }
  return req.ip;
}

module.exports = { clientIp };
