// Vercel serverless entry — the whole Express app as one function.
// server.js sets no listener when process.env.VERCEL is present, so importing it here just
// builds the app; Vercel invokes it per request. All env vars are set in the Vercel project.
import { app } from '../server.js';

// Guard the bare-root edge case: for GET / Vercel can hand the function a request whose url is
// '' or undefined, which makes Express's router throw (FUNCTION_INVOCATION_FAILED). Normalise it.
export default function handler(req, res) {
  if (!req.url) req.url = '/';
  return app(req, res);
}
