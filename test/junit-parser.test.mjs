import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { parseJunitXml } = await import("../dist/parsers/junit.js");

await describe("JUnit XML parser", async () => {

  await it("parses basic XML with testsuites wrapper", () => {
    const xml = `<?xml version="1.0"?>
<testsuites name="Suite" tests="2">
  <testsuite name="a.test.ts" tests="2" time="0.15">
    <testcase name="test A" classname="a.test.ts" time="0.1" />
    <testcase name="test B" classname="a.test.ts" time="0.05" />
  </testsuite>
</testsuites>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 2);
    assert.equal(run.results[0].name, "test A");
    assert.equal(run.results[0].file, "a.test.ts");
    assert.equal(run.results[0].status, "pass");
    assert.equal(run.results[0].durationMs, 100);
    assert.equal(run.results[1].durationMs, 50);
  });

  await it("parses direct testsuite (no wrapper)", () => {
    const xml = `<testsuite name="b.test.ts" tests="1" time="0.1">
    <testcase name="direct" classname="b.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].name, "direct");
  });

  await it("detects failure from <failure> element", () => {
    const xml = `<testsuite name="fail.test.ts" tests="1">
    <testcase name="fails" classname="fail.test.ts" time="0.5">
      <failure message="AssertionError: expected 1 to equal 2" />
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("AssertionError"));
  });

  await it("detects failure from <error> element", () => {
    const xml = `<testsuite name="err.test.ts" tests="1">
    <testcase name="throws" classname="err.test.ts" time="0.3">
      <error message="TypeError: undefined is not a function" />
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("TypeError"));
  });

  await it("detects skipped tests from <skipped> element", () => {
    const xml = `<testsuite name="skip.test.ts" tests="1">
    <testcase name="skipped" classname="skip.test.ts" time="0">
      <skipped/>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].status, "skip");
  });

  await it("handles self-closing testcases correctly", () => {
    const xml = `<testsuite name="self.test.ts" tests="3" time="0.3">
    <testcase name="one" classname="self.test.ts" time="0.1" />
    <testcase name="two" classname="self.test.ts" time="0.1" />
    <testcase name="three" classname="self.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 3);
    assert(run.results.every(r => r.status === "pass"));
  });

  await it("extracts error message from <failure> text content", () => {
    const xml = `<testsuite name="txt.test.ts" tests="1">
    <testcase name="txt fail" classname="txt.test.ts" time="0.2">
      <failure>AssertionError: expected false to be truthy
    at Context.<anonymous> (test.js:10:5)</failure>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("AssertionError"));
  });

  await it("handles multiple suites with mixed statuses", () => {
    const xml = `<?xml version="1.0"?>
<testsuites tests="4" failures="1" errors="1">
  <testsuite name="pass.test.ts" tests="2" failures="0" time="0.2">
    <testcase name="p1" classname="pass.test.ts" time="0.1" />
    <testcase name="p2" classname="pass.test.ts" time="0.1" />
  </testsuite>
  <testsuite name="mix.test.ts" tests="2" failures="1" errors="1" time="0.5">
    <testcase name="fail" classname="mix.test.ts" time="0.3">
      <failure message="fail msg" />
    </testcase>
    <testcase name="skip" classname="mix.test.ts" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 4);
    const passes = run.results.filter(r => r.status === "pass");
    const fails = run.results.filter(r => r.status === "fail");
    const skips = run.results.filter(r => r.status === "skip");
    assert.equal(passes.length, 2);
    assert.equal(fails.length, 1);
    assert.equal(skips.length, 1);
  });

  await it("converts time attribute to milliseconds correctly", () => {
    const xml = `<testsuite name="time.test.ts" tests="3">
    <testcase name="fast" classname="time.test.ts" time="0.001" />
    <testcase name="medium" classname="time.test.ts" time="1.5" />
    <testcase name="slow" classname="time.test.ts" time="10.0" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].durationMs, 1);
    assert.equal(run.results[1].durationMs, 1500);
    assert.equal(run.results[2].durationMs, 10000);
  });

  await it("handles empty time attribute", () => {
    const xml = `<testsuite name="notime.test.ts" tests="1">
    <testcase name="no time" classname="notime.test.ts" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].durationMs, 0);
  });

  await it("throws on completely empty input", () => {
    assert.throws(() => parseJunitXml(""), /Empty XML input/);
  });

  await it("returns empty results for XML with no testcase elements", () => {
    const xml = `<?xml version="1.0"?>
<testsuites name="empty" tests="0">
  <testsuite name="empty.test.ts" tests="0" time="0" />
</testsuites>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 0);
  });

  await it("preserves run metadata when provided", () => {
    const xml = `<testsuite name="meta.test.ts" tests="1">
    <testcase name="meta" classname="meta.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml, "custom-id", "abc123", "feature-x", "ci-42");
    assert.equal(run.id, "custom-id");
    assert.equal(run.commit, "abc123");
    assert.equal(run.branch, "feature-x");
    assert.equal(run.ciRunId, "ci-42");
  });

  await it("extracts error message from body when message attr absent", () => {
    const xml = `<testsuite name="errbody.test.ts" tests="1">
    <testcase name="body fail" classname="errbody.test.ts" time="0.5">
      <failure>RuntimeError: something went wrong</failure>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("RuntimeError"));
  });

  await it("truncates long error messages to 200 chars", () => {
    const longMsg = "Error: " + "x".repeat(500);
    const xml = `<testsuite name="long.test.ts" tests="1">
    <testcase name="long fail" classname="long.test.ts" time="0.5">
      <failure>${longMsg}</failure>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.ok(run.results[0].error && run.results[0].error.length <= 200);
  });

  await it("handles CDATA sections in failure elements", () => {
    const xml = `<testsuite name="cdata.test.ts" tests="1">
    <testcase name="cdata fail" classname="cdata.test.ts" time="0.5">
      <failure><![CDATA[AssertionError: expected 1 to deeply equal 2
    at UserContext.<anonymous> (test.js:10)]]></failure>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("AssertionError"));
    assert.ok(run.results[0].error?.includes("(test.js:10)"));
  });

  await it("handles CDATA with special XML characters", () => {
    const xml = `<testsuite name="special.test.ts" tests="1">
    <testcase name="special" classname="special.test.ts" time="0.3">
      <failure message=""><![CDATA[Error: value < 0 && value > 100 is not allowed]]></failure>
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].status, "fail");
    assert.ok(run.results[0].error?.includes("value < 0"));
  });

  await it("decodes XML entities in test name and classname", () => {
    const xml = `<testsuite name="entities.test.ts" tests="1">
    <testcase name="test &amp; verify &lt;data&gt;" classname="a &amp; b.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].name, "test & verify <data>");
    assert.equal(run.results[0].file, "a & b.test.ts");
  });

  await it("decodes numeric XML entities in test name", () => {
    const xml = `<testsuite name="num.test.ts" tests="1">
    <testcase name="test &#34;quoted&#34; &#x26; entity" classname="num.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results[0].name, "test \"quoted\" & entity");
  });

  await it("handles XML namespace prefixes on elements", () => {
    const xml = `<?xml version="1.0"?>
<ns:testsuites tests="2">
  <ns:testsuite name="ns.test.ts" tests="2" time="0.2">
    <ns:testcase name="ns test" classname="ns.test.ts" time="0.1" />
    <ns:testcase name="ns test 2" classname="ns.test.ts" time="0.1" />
  </ns:testsuite>
</ns:testsuites>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 2);
    assert.equal(run.results[0].name, "ns test");
  });

  await it("handles flat JUnit format (testcase directly under root)", () => {
    const xml = `<?xml version="1.0"?>
<testcase name="flat test" classname="flat.test.ts" time="0.1">
</testcase>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].name, "flat test");
    assert.equal(run.results[0].status, "pass");
  });

  await it("handles UTF-8 BOM at start of XML", () => {
    const bom = "﻿";
    const xml = bom + `<testsuite name="bom.test.ts" tests="1">
    <testcase name="bom test" classname="bom.test.ts" time="0.1" />
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].name, "bom test");
  });

  await it("decodes XML entities in error message attribute", () => {
    const xml = `<testsuite name="err.test.ts" tests="1">
    <testcase name="err ent" classname="err.test.ts" time="0.5">
      <failure message="AssertionError: expected 1 &lt; 2 to be false" />
    </testcase>
  </testsuite>`;
    const run = parseJunitXml(xml);
    assert.ok(run.results[0].error?.includes("1 < 2 to be false"));
  });

});
