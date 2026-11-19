const cards = Array.from({ length: 3 }, (_, index) => `
  <g-inner-card data-docid="${index + 1}">
    <div class="gkQHve">Water bottle ${index + 1}</div>
    <div aria-label="Current Price: $19.99. "></div>
    <span class="WJMUdc">Example Store</span>
    <span>4.5(12)</span>
    <img alt="Water bottle" src="https://example.com/product.png">
  </g-inner-card>`).join("");
const resultPage = `<html><body>${cards}${cards}</body></html>`;

export function createFixture() {
  let query;
  return {
    env: { GOOGLE_SHOPPING_TRAWL_BASE_URL: "http://localhost:8191" },
    fetcher: async (url, options) => {
      if (url.startsWith("https://www.google.com/search")) {
        query = new URL(url).searchParams.get("q");
        if (query === "missing.example") return new Response("<body>No shopping results</body>");
        return new Response("<html><title>Google Search</title><body>Enable JavaScript</body></html>");
      }
      if (url === "http://localhost:8191/scrape") {
        if (query === "denied.example") return new Response("private upstream details", { status: 403 });
        const request = JSON.parse(options.body);
        return Response.json({ url: request.url, statusCode: 200, html: resultPage });
      }
      throw new Error("Unexpected fixture URL");
    },
  };
}
