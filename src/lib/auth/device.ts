import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export function isAuthorizedDevice(request: NextRequest) {
  const expectedToken = process.env.ROMI_DEVICE_TOKEN;
  const authorization = request.headers.get("authorization");

  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(expectedToken);

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
