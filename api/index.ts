import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { createApp } from "../backend/src/app.js";

// Vercel Serverless entrypoint.
//
// We export a plain function handler (the shape @vercel/node always accepts as
// a valid default export) and build the Express app lazily on the first
// request. Building lazily — instead of `export default createApp()` — keeps
// all app construction out of module-evaluation time, so a cold-start hiccup
// cannot leave the module without a valid default export (which previously
// surfaced as: "Invalid export found ... The default export must be a function
// or server"). The app is memoized for the lifetime of the warm instance.
let app: Express | undefined;

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (!app) {
    app = createApp();
  }
  app(req, res);
}
