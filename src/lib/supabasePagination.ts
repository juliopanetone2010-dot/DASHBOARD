const DEFAULT_PAGE_SIZE = 1000;

type SupabaseQueryLike<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>;
};

export async function fetchAllRows<T>(
  buildQuery: () => SupabaseQueryLike<T> | any,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let start = 0;

  for (;;) {
    const { data, error } = await buildQuery().range(start, start + pageSize - 1);
    if (error) throw error;

    const rows = data ?? [];
    out.push(...rows);

    if (rows.length < pageSize) break;
    start += pageSize;
  }

  return out;
}