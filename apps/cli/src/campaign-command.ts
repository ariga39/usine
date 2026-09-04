import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { readFile } from "node:fs/promises";
import {
  campaignEvidence,
  getCampaign,
  proposeCampaign,
  publishCampaign,
  recordCampaignDecisionTouch,
} from "./server-client.js";
import { notFoundFailure, runCommand } from "./cli-failure.js";
import { jsonFlag } from "./cli-parameters.js";
import { renderCampaignEvidence, renderJson } from "./cli-renderer.js";

export function campaignCommand(serverUrl: string) {
  const publish = Command.make(
    "publish",
    { contractPath: Argument.string("goal-contract.json"), json: jsonFlag() },
    ({ contractPath, json }) =>
      Effect.promise(() =>
        runCommand("campaign_publish_failed", async () => {
          const campaign = await publishCampaign(serverUrl, { contractPath });
          process.stdout.write(
            json ? renderJson(campaign) : `Campaign ${campaign.campaignId}: ${campaign.status}\n`,
          );
        }),
      ),
  );
  const get = Command.make(
    "get",
    { campaignId: Argument.string("campaign-id"), json: jsonFlag() },
    ({ campaignId, json }) =>
      Effect.promise(() =>
        runCommand("campaign_get_failed", async () => {
          const campaign = await getCampaign(serverUrl, campaignId);
          if (!campaign) throw notFoundFailure("campaign", "campaignId", campaignId);
          process.stdout.write(
            json ? renderJson(campaign) : `Campaign ${campaign.campaignId}: ${campaign.status}\n`,
          );
        }),
      ),
  );
  const propose = Command.make(
    "propose",
    {
      campaignId: Argument.string("campaign-id"),
      proposalPath: Argument.string("proposal.json"),
      json: jsonFlag(),
    },
    ({ campaignId, proposalPath, json }) =>
      Effect.promise(() =>
        runCommand("campaign_propose_failed", async () => {
          const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
          const campaign = await proposeCampaign(serverUrl, campaignId, proposal);
          process.stdout.write(
            json ? renderJson(campaign) : `Campaign ${campaign.campaignId}: ${campaign.status}\n`,
          );
        }),
      ),
  );
  const evidence = Command.make(
    "evidence",
    { campaignId: Argument.string("campaign-id"), json: jsonFlag() },
    ({ campaignId, json }) =>
      Effect.promise(() =>
        runCommand("campaign_evidence_failed", async () => {
          const report = await campaignEvidence(serverUrl, campaignId);
          if (!report) throw notFoundFailure("campaign", "campaignId", campaignId);
          process.stdout.write(renderCampaignEvidence(report, json));
        }),
      ),
  );
  const touch = Command.make(
    "touch",
    {
      campaignId: Argument.string("campaign-id"),
      touchId: Argument.string("touch-id"),
      json: jsonFlag(),
    },
    ({ campaignId, touchId, json }) =>
      Effect.promise(() =>
        runCommand("campaign_touch_failed", async () => {
          const campaign = await recordCampaignDecisionTouch(serverUrl, campaignId, touchId);
          process.stdout.write(
            json ? renderJson(campaign) : `Campaign ${campaign.campaignId}: ${campaign.status}\n`,
          );
        }),
      ),
  );
  return Command.make("campaign").pipe(
    Command.withSubcommands([publish, get, propose, evidence, touch]),
  );
}
