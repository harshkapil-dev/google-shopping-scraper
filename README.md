# Google Shopping

Search Google Shopping product listings by keyword, country, and language. Each request retrieves up to 40 product listings from one results page. The worker reports seller, price, currency, rating, reviews, image and product links, and sponsored placement when present in the upstream data.

The worker uses the [DataForSEO Google Shopping Products API](https://docs.dataforseo.com/v3/merchant/google/products/task_post). Set `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` in the secret environment for live requests. The Railway deployment also uses a scoped `PULLDATA_WORKER_TOKEN`. A request creates one high-priority provider task. Its identifier is persisted for async jobs so that polling can resume after a worker interruption.

`npm ci` installs the locked dependencies. `npm test` runs deterministic contract and extraction tests. For a local live run, set `SCRAPER_QUEUE_REDIS_URL` to a development Redis instance and start the worker with `npm start`. The smoke input is in `pulldata.input.json`. Job results are retained for 24 hours.

Marketplace deployments use the dedicated Postgres database assigned by Pulldata for job state. Local runs can use Redis or a Postgres database with the schema in `job-store.sql`.
