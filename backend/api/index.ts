import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { createApp } from "../src/app.js";

// Vercel Serverless entrypoint (used when the backend is deployed on its own).
// Export a plain function handler and build the Express app lazily on the first
// request so app construction never runs at module-evaluation time. See the
// root api/index.ts for the full rationale.
let app: Express | undefined;

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (!app) {
    app = createApp();
  }
  app(req, res);
}
