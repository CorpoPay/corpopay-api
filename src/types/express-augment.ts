import type { UserRole } from "@/generated/prisma/client";

declare module "express-serve-static-core" {
  interface Request {
    user?: {
      id: string;
      tenantId: string;
      role: UserRole;
      email: string;
    };
  }
}
