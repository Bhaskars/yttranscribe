// Vercel function entry point. Every /api/* request is handled by the same
// HTTP handler that powers the local Node server, so streaming and routing
// behave identically in both places.
import { handler } from '../server.js';

export default function api(req, res) {
  return handler(req, res);
}
