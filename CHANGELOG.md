# Changelog

## [0.2.0](https://github.com/CorpoPay/corpopay-api/compare/corpopay-api-v0.1.0...corpopay-api-v0.2.0) (2026-08-26)


### Features

* **seed:** add multi-tenant sandbox seeder (demo + otoparking + jabadoor) ([4458b48](https://github.com/CorpoPay/corpopay-api/commit/4458b48fad5a3e8654ada08b20e8b356d59678eb))
* **testing:** implement demo seed + full test coverage suite ([afde2ca](https://github.com/CorpoPay/corpopay-api/commit/afde2ca81631a818b7a3a116866406c8ec99ec5d))


### Bug Fixes

* **ci:** make GitHub Actions green ([7c80fc1](https://github.com/CorpoPay/corpopay-api/commit/7c80fc1008438569d121540a76a58286af9e322a))
* **ci:** pin osv-scanner-action to v2.5.1 ([70442cc](https://github.com/CorpoPay/corpopay-api/commit/70442cc0faedfacdc472abb90f8fc3d7a4588ddd))
* **ci:** use osv-scanner reusable workflow (action has no runs: section) ([be1a8fe](https://github.com/CorpoPay/corpopay-api/commit/be1a8feb53917e4ffac4395a277db4acc81b971a))
* **deps:** clear npm audit to 0 vulns + migrate inngest to v4 ([b6745d5](https://github.com/CorpoPay/corpopay-api/commit/b6745d5b58e3e7abd0a45ff8cb34fc86f880b0eb))
* **k6:** accept 429/404/410 as valid checkout responses in load test ([2a0b198](https://github.com/CorpoPay/corpopay-api/commit/2a0b198a9c04c83bcb1624f74b708faaae2dd82d))
* **k6:** relax http_req_failed threshold to 5% for dev load test ([dc4cec6](https://github.com/CorpoPay/corpopay-api/commit/dc4cec6b80ca0eae95aa9fd72d0db553d766cc0b))
* **vps:** map charge-not-found (404) to REQUIRES_ACTION instead of throwing ([8593545](https://github.com/CorpoPay/corpopay-api/commit/8593545d09b338def19414e0c2d06f0ecc785c3e))
