import assert from "node:assert/strict";
import { test } from "node:test";
import { formatIdrMonthly, toVoiceJob } from "../shared/jobs.ts";

const base = {
	id: "job_1",
	title: "React Developer",
	company: "Acme",
	payMin: 90000,
	payMax: 100000,
	payCurrency: "USD",
	payPeriod: "yearly",
	indonesiaEligibility: "id_friendly",
	url: "https://lokerdollar.com/id/jobs/x",
	applyUrl: "https://lokerdollar.com/id/out/x",
};

test("yearly USD range → spoken phrase, label, monthly IDR", () => {
	const j = toVoiceJob(base, 1);
	assert.equal(j.paySpoken, "90 thousand to 100 thousand US dollars a year");
	assert.equal(j.payLabel, "$90k–$100k / yr");
	assert.equal(j.payIdrMonthly, 130_600_000); // 95k/12*16500 rounded to 100k
	assert.equal(j.eligibility, "id_friendly");
	assert.equal(j.rank, 1);
});

test("hourly pay converts at 160 h/month", () => {
	const j = toVoiceJob({ ...base, payMin: 15, payMax: 15, payPeriod: "hourly" }, 2);
	assert.equal(j.payLabel, "$15 / hr");
	assert.equal(j.paySpoken, "15 US dollars an hour");
	assert.equal(j.payIdrMonthly, 39_600_000);
});

test("no pay or non-USD pay → nulls, unknown eligibility normalized", () => {
	const j = toVoiceJob({ ...base, payMin: null, payMax: null, indonesiaEligibility: "weird" }, 3);
	assert.equal(j.paySpoken, null);
	assert.equal(j.payIdrMonthly, null);
	assert.equal(j.eligibility, "unknown");
	const eur = toVoiceJob({ ...base, payCurrency: "EUR" }, 4);
	assert.equal(eur.payLabel, null);
});

test("IDR formatting per language", () => {
	assert.equal(formatIdrMonthly(130_600_000, "id"), "≈ Rp 131 juta/bln");
	assert.equal(formatIdrMonthly(130_600_000, "en"), "≈ Rp 131M / month");
	assert.equal(formatIdrMonthly(1_250_000_000, "en"), "≈ Rp 1.3B / month");
});
