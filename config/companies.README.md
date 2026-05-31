# How to add your 100 companies

Each company is one entry in `companies.json`. You give it an `ats` type and an
`id` (the company's slug on that ATS). jobnow then hits that ATS's public JSON/XML
API — no scraping, no bot-blocking.

```json
{ "name": "Display Name", "ats": "greenhouse", "id": "the-slug" }
```

## How to find a company's ATS + id

Open the company's careers page and look at the URL / "Apply" links:

| You see in the URL…                          | ats           | id is…                              |
|----------------------------------------------|---------------|-------------------------------------|
| `boards.greenhouse.io/acme`                  | `greenhouse`  | `acme`                              |
| `jobs.lever.co/acme`                         | `lever`       | `acme`                              |
| `acme.jobs.personio.de` / `.com`             | `personio`    | `acme` (+ set `"tld": "com"` if .com)|
| `jobs.ashbyhq.com/acme`                      | `ashby`       | `acme`                              |
| `acme.recruitee.com`                         | `recruitee`   | `acme`                              |
| `jobs.smartrecruiters.com/Acme`              | `smartrecruiters` | `Acme` (exact case)             |
| anything else / custom page                  | `custom`      | put the full careers URL in `"url"` |

For `custom`, jobnow fetches the page HTML and lets Gemini read it (no reliable
"posted date", so those always show up — flagged `date unknown`).

```json
{ "name": "Acme", "ats": "custom", "url": "https://acme.com/careers" }
```

## Don't know the ATS? Let jobnow detect it
Run the detector with a careers URL or company domain and it tells you the entry to paste:

```
curl "http://localhost:3000/api/detect?url=acme.com/careers"
```

## Tip
Direct-employer career pages are higher-signal than LinkedIn/Xing/StepStone — no
recruiter spam, no duplicates. 100 of these = a strong daily pipeline.
