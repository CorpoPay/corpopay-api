import { z } from "zod";
import { UserRole } from "@/generated/prisma/client";

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum([UserRole.STAFF, UserRole.OWNER]),
  password: z.string().min(8),
});

export const changeRoleSchema = z.object({
  role: z.enum([UserRole.STAFF, UserRole.OWNER]),
});
