# Google Shopping

Search Google Shopping product listings by keyword, country, and language. Each request retrieves up to 40 product listings from one results page. The worker reports seller, price, currency, rating, reviews, image and product links, and sponsored placement when present in the upstream data.

The worker requests Google's public Shopping results directly, then tries the configured Webshare proxy when Google returns a JavaScript shell or blocks the request. Its final fallback is the private Trawl browser in the development Railway network. Set `GOOGLE_SHOPPING_TRAWL_BASE_URL` to that private origin; optionally provide the four existing `WEBSHARE_PROXY_*` values as secret runtime variables. No third-party shopping data provider is used. The worker accepts `PULLDATA_WORKER_TOKEN` when the platform supplies one.

Google's current Shopping cards expose titles, merchants, prices, and often ratings. Product IDs, direct seller URLs, image URLs, and sponsored status are returned as `null` when a card does not expose them. In that case `shopping_url` is a Google Shopping search for the product title. Only real cards are returned; a challenge page is an error.

`npm ci` installs the locked dependencies. `npm test` runs deterministic contract and extraction tests. For a local live run, set `SCRAPER_QUEUE_REDIS_URL` to a development Redis instance and start the worker with `npm start`. The smoke input is in `pulldata.input.json`. Job results are retained for 24 hours.

Marketplace deployments use a dedicated development Postgres database assigned by Pulldata for job state. Before the first deployment, provision a database for `google-shopping-scraper`, apply `job-store.sql`, and grant a non-owner worker role `CONNECT` on the database, `USAGE` on `public`, and `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on `marketplace_worker_jobs`. Add the worker role's connection URL under the slug in the trusted backend `MARKETPLACE_DEVELOPMENT_SCRAPER_DATABASE_URLS_JSON` mapping. Never send that URL through scraper `runtimeEnv` or commit it to this repository. Local runs can use Redis or a Postgres database with the same schema.
