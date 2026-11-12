// Stock check: how filings and headlines are sorted into the pop-up's filter groups (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { filingGroup, newsGroup, ratingMove } from "../lib/stock-check.js";

test("headlines land in the right group", () => {
  const cases = [
    ["HFCL Bags Rs 834 Cr Export Order for Optical Fibre Cables", "Order book"],
    ["BharatNet Phase 3: HFCL wins new ₹2,666 crore deal from Rail Vikas Nigam", "Order book"],
    ["HFCL Plans Aerospace Acquisition With ₹1,600–1,800 Crore Order Book", "M&A / Restructuring"],
    ["Suzlon board approves fund raising via QIP of up to ₹2,000 crore", "QIP"],
    ["Paytm to issue preferential shares to promoters", "Preferential issue"],
    ["ICRA upgrades Tata Power's rating to AA+", "Credit rating"],
    ["SEBI issues show-cause notice to company over disclosures", "Compliance / Audit / Legal"],
    ["Statutory auditor resigns citing lack of information", "Compliance / Audit / Legal"],
    ["Tata Power says no provision needed for $650 million arbitration award", "Compliance / Audit / Legal"],
    ["Tata Power Signs MoU with BPCL to Develop 110 kV Power Infrastructure", "JV / Agreement"],
    ["Company announces 1:1 bonus issue and stock split; record date fixed", "Corporate action"],
    ["HFCL's Q2FY27 PAT grows 448% on-year", "Results"],
    ["Tata Power Renewables Commissions 300 MW Project for SECI in Karnataka", "Capacity / Commissioning"],
    ["Tata Power: Citi Buy at Rs 525, JPMorgan Neutral at Rs 423, CLSA Hold at Rs 415", "Analyst / brokerage report"],
    ["Tata Power Q2 review: Brokerages remain bullish on renewables", "Analyst / brokerage report"],
    ["Jefferies initiates coverage on HFCL with a buy", "Analyst / brokerage report"],
    ["Kotak Mahindra Bank Q2 results: profit rises 12%", "Results"],
    ["Stocks to watch today: Tata Power, SBI, ITC", "Other news"],
    ["Fine-tuning the grid: Tata Power's new control room", "Other news"],
  ];
  for (const [title, want] of cases) assert.equal(newsGroup(title), want, title);
});

test("filings: NSE's theme sets the group, QIP and preferential are told apart, press releases are read", () => {
  assert.equal(filingGroup("Order win", "Bagging/Receiving of orders"), "Order book");
  assert.equal(filingGroup("Fund raising", "Qualified Institutional Placement opens"), "QIP");
  assert.equal(filingGroup("Fund raising", "Allotment of Securities on preferential basis"), "Preferential issue");
  assert.equal(filingGroup("Fund raising", "Rights issue of equity shares"), "Rights / other fund raising");
  assert.equal(filingGroup("Compliance / Audit", "Change in Auditors"), "Compliance / Audit / Legal");
  assert.equal(filingGroup("Dividend", "Interim dividend"), "Corporate action");
  assert.equal(filingGroup("News", 'Press Release "Tata Power Renewables Commissions 300 MW Project"'), "Capacity / Commissioning");
  assert.equal(filingGroup("News", "Press Release on financial performance of the quarter"), "Results");
});

test("credit rating moves", () => {
  assert.deepEqual(["CARE downgrades to BBB", "ICRA upgrades to AA", "CRISIL revises outlook to positive", "Rating reaffirmed at A+", "Rating assigned"].map(ratingMove), ["Downgrade", "Upgrade", "Outlook revised", "Reaffirmed", ""]);
});
