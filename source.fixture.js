const taskId = "00000000-0000-4000-8000-000000000000";
const rows = Array.from({ length: 3 }, (_, index) => ({
  type: "google_shopping_serp",
  title: `Water bottle ${index + 1}`,
  product_id: String(index + 1),
  seller: "Example Store",
  price: 19.99,
  currency: "USD",
  product_rating: { value: "4.5", votes_count: 12 },
  product_images: ["https://example.com/product.png"],
}));

export function createFixture() {
  let query;
  let depth;
  return {
    env: { DATAFORSEO_LOGIN: "placeholder-data", DATAFORSEO_PASSWORD: "placeholder-data" },
    fetcher: async (url, { method, body }) => {
      if (method === "POST") {
        [{ keyword: query, depth }] = JSON.parse(body);
        if (query === "denied.example") return new Response("private upstream details", { status: 403 });
        return Response.json({ status_code: 20000, tasks: [{ status_code: 20100, id: taskId }] });
      }
      const items = query === "missing.example" ? null : [rows[0], ...rows.slice(0, depth)];
      return Response.json({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items }] }] });
    },
  };
}
