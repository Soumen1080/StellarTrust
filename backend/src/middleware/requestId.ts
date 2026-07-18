/** Attaches a per-request id used in logs and the API error envelope. */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface RequestWithId extends Request {
  requestId: string;
}

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header("x-request-id");
  const id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader("x-request-id", id);
  next();
}
