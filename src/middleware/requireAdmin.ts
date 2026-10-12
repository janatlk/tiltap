import type { Request, Response, NextFunction } from "express";
import { authenticate } from "../services/adminAuthService";
import { currentAnnotator } from "../services/datasetAuthService";
import { isSuperAdmin } from "../services/datasetPermissions";

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

  // Учётки разметки годятся и здесь, но только роль супер-админа. Одна система
  // аккаунтов на все закрытые страницы означает одно место, где человека
  // заводят, и одно место, где его отключают: пока их было две, отзыв доступа
  // в одной оставлял вторую открытой.
  //
  // Машинный токен остаётся: им пользуются скрипты, и это запасной путь внутрь,
  // если с учётками разметки что-то случится.
  const annotator = await currentAnnotator(req);
  if (annotator && isSuperAdmin(annotator)) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
