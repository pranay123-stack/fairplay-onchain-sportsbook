import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

export type Db = PrismaClient;
export { Prisma } from "./generated/prisma/client.ts";

export function createDb(url: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Prisma Decimal / bigint / number → decimal string of base units. */
export function dec(v: { toFixed(dp?: number): string } | bigint | number | null | undefined): string {
  if (v === null || v === undefined) return "0";
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  return v.toFixed(0);
}
