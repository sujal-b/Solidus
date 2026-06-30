/**
 * Slack webhook integration for solidus.
 *
 * When SOLIDUS_SLACK_WEBHOOK environment variable is set, sends a formatted
 * flake report to the configured Slack channel after each analyze run.
 */

import type { AnalysisReport, SolidusConfig } from "../core/types.js";
import type { Logger } from "../core/logger.js";

const WEBHOOK_ENV = "SOLIDUS_SLACK_WEBHOOK";

export function sendSlackWebhook(
  report: AnalysisReport,
  _config: SolidusConfig,
  log: Logger,
): void {
  const webhookUrl = process.env[WEBHOOK_ENV];
  if (!webhookUrl) return; // not configured — skip silently

  const blocks = buildSlackBlocks(report);
  const payload = JSON.stringify({ blocks, text: slackSummary(report) });

  // Use fetch (available in Node 18+)
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  }).then(res => {
    if (!res.ok) {
      log.warn(`Slack webhook returned ${res.status}: ${res.statusText}`);
    }
  }).catch(err => {
    log.warn(`Slack webhook failed: ${(err as Error).message}`);
  });

  log.debug(`Slack webhook sent (${report.flaky} flaky, ${report.stable} stable)`);
}

function slackSummary(report: AnalysisReport): string {
  const parts: string[] = [];
  parts.push(`solidus flake report`);
  if (report.stable > 0) parts.push(`${report.stable} stable`);
  if (report.flaky > 0) parts.push(`${report.flaky} flaky`);
  if (report.broken > 0) parts.push(`${report.broken} broken`);
  if (report.quarantined > 0) parts.push(`${report.quarantined} quarantined`);
  parts.push(`${report.total} total tests`);
  return parts.join(" · ");
}

function buildSlackBlocks(report: AnalysisReport): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧪 solidus flake report", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Total:* ${report.total}` },
        { type: "mrkdwn", text: `*Stable:* ${report.stable} ✅` },
        { type: "mrkdwn", text: `*Flaky:* ${report.flaky} ⚠️` },
        { type: "mrkdwn", text: `*Broken:* ${report.broken} ❌` },
        { type: "mrkdwn", text: `*Quarantined:* ${report.quarantined} 🔒` },
        { type: "mrkdwn", text: `*New:* ${report.insufficientData} 📊` },
      ],
    },
    { type: "divider" },
  ];

  const problematic = report.flakes.filter(f =>
    f.classification === "flaky" || f.classification === "stable_fail"
  );

  if (problematic.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Tests needing attention:*" },
    });
    for (const f of problematic.slice(0, 10)) {
      const icon = f.classification === "stable_fail" ? "❌" : "⚠️";
      const q = f.quarantined ? " 🔒" : "";
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `${icon} \`${f.file}\` :: ${f.name} — ${f.passCount}/${f.totalRuns} passed${q}` },
        ],
      });
    }
    if (problematic.length > 10) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `...and ${problematic.length - 10} more` }],
      });
    }
  }

  // Machine-readable JSON in hidden section for potential automation
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `solidus ${report.runId} · <https://github.com/sujal-b/Solidus|solidus>` }],
  });

  return blocks;
}
