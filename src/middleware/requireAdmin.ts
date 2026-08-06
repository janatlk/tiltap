import type { Request, Response, NextFunction } from "express";
import { authenticate, passwordConfigured } from "../services/adminAuthService";

/**
 * Gate every admin route in one place.
 *
 * Previously each handler checked the token itself, which meant a new endpoint
 * was unprotected until somebody remembered to add the check. Mounting the
 * gate on the router removes that failure mode: a route added later is
 * protected because of where it lives, not because of what it remembers to do.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await authenticate(req);
  if (result.ok) {
    next();
    return;
  }

  res.status(401).json({
    error: "Unauthorized",
    // Lets the panel show a login form instead of a bare error.
    loginRequired: passwordConfigured(),
  });
}
