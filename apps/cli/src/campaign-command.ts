import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { getCampaign, publishCampaign } from "./server-client.js";
import { notFoundFailure, runCommand } from "./cli-failure.js";
import { jsonFlag } from "./cli-parameters.js";
import { renderJson } from "./cli-renderer.js";

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
  return Command.make("campaign").pipe(Command.withSubcommands([publish, get]));
}
