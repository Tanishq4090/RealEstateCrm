# Sources

Every outside figure in this repository, where it came from, and how far to trust it. All pages were read on 31 October 2026. Vendor marketing is marked as weak.

Do not mix the Knight Frank and Anarock series. They cover different cities and use different methods: their 2025 totals are 3,48,207 and about 3,95,625 homes.

## Market

| Figure | Quote | Source | Date | Confidence |
|---|---|---|---|---|
| 3,48,207 homes sold in 2025 across 8 cities: Mumbai, NCR, Bengaluru, Pune, Hyderabad, Ahmedabad, Chennai, Kolkata | "Full-year 2025 sales of 348,207 units" | [Knight Frank, India Real Estate H1 2026](https://content.knightfrank.com/research/3116/documents/en/india-real-estate-office-and-residential-market-h1-2026-12927.pdf), p.5 | Jul 2026 | High |
| 2,58,238 homes sold, January to September 2026, same 8 cities | "held steady at 258,238 units between January and September 2026" | [Knight Frank release, reprinted](https://investmentguruindia.com/newsdetail/india-s-residential-sales-hold-steady-in-9m-cy2026-as-market-divergence-widens-knight-frank-india519254) | 5 Oct 2026 | Medium to high |
| About 3,95,625 homes worth over ₹6 lakh crore in 2025 across 7 cities: NCR, MMR, Bengaluru, Pune, Hyderabad, Chennai, Kolkata | "approx. 3,95,625 units sold in the year"; "over INR 6 lakh Cr in 2025" | [Anarock, reprinted](https://investmentguruindia.com/newsdetail/housing-sales-vol-falls-14-y-o-y-in-2025-sales-value-up-6-in-top-7-cities-anarock274792) | 27 Dec 2025, before the year ended | Medium |
| 1,72,861 RERA projects and 1,26,848 RERA agents | Fields `totalNumberOfProject` and `nos`, summed the way the portal's own script does | [MoHUA Unified RERA Portal](https://rera.mohua.gov.in/) | Latest rows 19 to 25 Oct 2026 | Medium to high |
| 13,000+ developers | "13000+ Developers across 230 city chapters in 20 states" | [CREDAI](https://credai.org/) | Undated, self-reported | Medium |

The RERA totals have no single as-of date. 15 of the 37 rows were last reported before August 2026, and seven of those are zeros. The rendered number on the page was not seen, only the data feed behind it. Publish them as "as reported on MoHUA's Unified RERA Portal, October 2026".

CREDAI's count covers its members, not every developer in India.

## Selling costs

| Figure | Quote | Source | Date | Confidence |
|---|---|---|---|---|
| ₹16,383 a month, range ₹9,330 to ₹28,768, 1.8k salaries | "The average salary for a caller is ₹16,383 per month" | [Indeed India](https://in.indeed.com/career/telecaller/salaries) | 5 Jun 2026 | Medium |
| Channel commission of 1% to 3% | "about one to three percent of the sale value" | [Aurum PropTech FAQ](https://www.aurumproptech.in/pulse/faqs/what-is-the-brokerage-rate-paid-to-channel-partners-by-builders), weak | Undated | Low |
| Same range, up to 5% for luxury or commercial | "1-3%, up to 5% luxury/commercial" | [GHAR.tv](https://www.ghar.tv/intelligence/india-real-estate-broker-channel-partner-industry-report-2026/artgi414), weak, its own estimate | Jul 2026 | Low |
| Outsourced sales share of 42% in 2022 to 49% in 2025 | "The developer pays the marketing spend and the brokers' commission directly" | [Newboard summary of Anarock's DRHP](https://newboard.in/ipo/anarock-property-consultants), a company-commissioned report; the DRHP itself was not opened | 13 Oct 2026 | Low to medium |

The Indeed figure covers callers in all sectors and is a wage, not a loaded employer cost. No real-estate-specific pre-sales salary could be verified. AmbitionBox and Glassdoor could not be read.

No audited or regulator figure exists for commission rates in the sources found.

## Lead response

| Figure | Quote | Source | Date | Confidence |
|---|---|---|---|---|
| Audit of 2,241 US firms: 37% replied within 1 hour, 16% in 1 to 24 hours, 24% after 24 hours, 23% never | "23% of the companies never responded at all" | [SmartCompany](https://www.smartcompany.com.au/marketing/20110704-are-you-letting-online-leads-go-cold/), summarising [HBR, March 2011](https://hbr.org/2011/03/the-short-life-of-online-sales-leads) | 4 Jul 2011 | Medium |
| Replying within an hour: nearly 7 times as likely to qualify the lead as an hour later, over 60 times as likely as 24 hours or more | "nearly seven times as likely to qualify the lead"; "more than 60 times as likely" | Same | 4 Jul 2011 | Medium |

The HBR text is paywalled, so these figures come through a secondary summary and should be checked against the article. They are US figures from 2011. The widely quoted 21x and 100x figures come from a different study and are not used here.

## Bolna

| Figure | Quote | Source | Date | Confidence |
|---|---|---|---|---|
| $0.06 a minute (₹5.52) on preferred models | "starts at $0.06 per minute"; "6.00¢ (₹5.52)per minute" | [Bolna pricing](https://www.bolna.ai/pricing) | Undated | High |
| Telephony and platform fee are extra | "Telephony and the platform fee are added per minute." | Same | Undated | High |
| `total_cost` is in cents | "Total cost incurred by this execution in cents" | [Bolna API reference](https://www.bolna.ai/docs/api-reference/executions/get_execution.md) | Undated | High |

## TRAI rules

These are our reading of the regulations, not legal advice. Have a lawyer confirm them before any live campaign.

| Rule | Quote | Source | Date | Confidence |
|---|---|---|---|---|
| Midnight to 10 AM and 9 PM to midnight are off by default, which leaves 10 AM to 9 PM | "Time Bands (i), (ii), (iii) and (ix) shall be default OFF for all customers" | [TCCCPR 2018](https://trai.gov.in/sites/default/files/2025-01/RegulationUcc19072018.pdf), p.32 | 19 Jul 2018 | High on text, medium to high on our reading |
| The older "9 to 9" rule came from repealed regulations | "to be sent only between 0900 to 2100 hrs"; "are hereby repealed" | Same, p.49 and p.21 | 19 Jul 2018 | High |
| 140-series numbers are mandatory for promotional calls | "use of 140xx series numbers for making promotional calls by entities of any sector" | [TRAI press release 91/2026](https://trai.gov.in/sites/default/files/2026-07/PR_No91of2026.pdf) | 10 Jul 2026 | High |
| Normal 10-digit numbers are barred for telemarketing | "restricts senders from using normal 10-digit numbers for telemarketing" | [TRAI press release 11/2025](https://www.trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf) | 12 Feb 2025 | High |
| Calling without human dialling, using artificial voice, falls under the new A2P definition | "without direct human dialling... artificial voice technologies" | [Gazette No. 561](https://egazette.gov.in/WriteReadData/2026/276548.pdf), p.77 | 18 Sep 2026 | High on text, our reading on scope |
| A2P calling numbers must be declared | "shall be treated as Unsolicited commercial communication" | [TRAI regulation, 18 Sep 2026](https://www.trai.gov.in/sites/default/files/2026-09/Regulation_18092026.pdf), regulation 4, p.3 | 18 Sep 2026 | High |
| Enquiry-based calling lasts 7 days, and the enquiry must be written or digital and verifiable | "within seven days immediately preceding" | Gazette No. 561, p.78 | 18 Sep 2026 | High |
| Older consent counts only if registered in the Consent Register | "subsequently registered in the Consent Register" | Gazette No. 561, p.77 | 18 Sep 2026 | High |
| No new consent request for 90 days after an opt-out | "before ninety (90) days" | TRAI press release 11/2025 | 12 Feb 2025 | High |
| Commencement in phases at 30, 60 and 90 days | "shall come into force after thirty days" | Gazette No. 561 | 18 Sep 2026 | Medium on exact dates |

Consent may not lift the time bands. The text is ambiguous, so PropReach stays inside them regardless.

## Our own measurements

These come from the 5 real calls made on 31 October 2026, read from Bolna's execution records and the call recordings. Sample calls are excluded.

| Measure | Result |
|---|---|
| Connected real calls | 5, totalling 450 seconds |
| Total cost | 44.62¢, or 5.95¢ a minute |
| Silence after a filler word on lookup turns | 2.2 to 4.3 seconds, on the 82-second call |
| Time for the model to finish a reply, median | 1,247 ms on gpt-5.4-mini, 661 to 913 ms on gpt-4.1-mini |
| Delay in detecting end of speech | About 0.6 seconds |
| Gaps inside sentences on the earlier Kalpa voice | 0.43 to 0.61 seconds |

The cost is Bolna's billed `total_cost`. Its `cost_breakdown` lists LLM, voice, transcription, network and platform lines, but those lines do not add up to the total on every call, so we report the billed figure and do not claim it covers every fee.

## Looked for and not found

- An independent source for Indian real-estate lead conversion, cost per lead or response times. The published figures are vendor claims with no data, so they are not used.
- A government count of developers in India.
- Bolna's telephony and platform fees as published prices. The measured figures above come from its execution records.
