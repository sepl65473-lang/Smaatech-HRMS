import { UAParser } from 'ua-parser-js';

// Server derives device/browser/OS from the raw User-Agent header itself —
// never from a client-computed label, which the client could just lie about.
export function parseDeviceInfo(userAgentHeader) {
  const { device, browser, os } = UAParser(userAgentHeader || '');
  const deviceType = device.type || 'desktop'; // ua-parser-js leaves this undefined for desktops
  const deviceName = device.vendor && device.model
    ? `${device.vendor} ${device.model}`
    : (os.name ? `${os.name} ${deviceType}` : 'Unknown device');
  return {
    name: deviceName,
    type: deviceType,
    browser: browser.name ? `${browser.name} ${browser.version || ''}`.trim() : 'Unknown browser',
    os: os.name ? `${os.name} ${os.version || ''}`.trim() : 'Unknown OS',
  };
}

// Prefer the first hop of X-Forwarded-For (set by a reverse proxy) over
// req.ip, which is otherwise just the proxy's own address in production.
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip;
}
