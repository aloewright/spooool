const KEY = (userId: string, route: string) => `circuit:${userId}:${route}`;

export async function checkCircuit(
  kv: KVNamespace,
  userId: string,
  route: string,
): Promise<"open" | "closed"> {
  return (await kv.get(KEY(userId, route))) ? "open" : "closed";
}

export async function tripCircuit(
  kv: KVNamespace,
  userId: string,
  route: string,
  seconds: number,
): Promise<void> {
  await kv.put(KEY(userId, route), "open", { expirationTtl: seconds });
}

export async function resetCircuit(kv: KVNamespace, userId: string, route: string): Promise<void> {
  await kv.delete(KEY(userId, route));
}
