import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const scenario = JSON.parse(process.env.PRODUCT_STUDIO_FAKE_ACP_SCENARIO ?? "{}");
const sentinelPath = process.env.PRODUCT_STUDIO_FAKE_ACP_SENTINEL ?? null;
const sessionId = "product-studio-fake-session";

function permissionOptions() {
  return [
    { kind: "allow_once", name: "Allow once", optionId: "allow" },
    { kind: "reject_once", name: "Reject once", optionId: "reject" },
  ];
}

const application = acp
  .agent({ name: "product-studio-fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, (context) => {
    if (!Array.isArray(context.params.mcpServers) || context.params.mcpServers.length !== 0) {
      throw new Error("The client must request zero MCP servers.");
    }
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (scenario.kind === "silent_refusal") {
      return { stopReason: "refusal" };
    }

    if (typeof scenario.delay_ms === "number" && scenario.delay_ms > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, scenario.delay_ms));
    }

    if (scenario.write_cwd === true && sentinelPath !== null) {
      await writeFile(`${sentinelPath}.cwd`, `${process.cwd()}\n`, "utf8");
    }

    await context.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "This terminal-shaped message must not become durable evidence.",
        },
      },
    });

    const requests = Array.isArray(scenario.requests) ? scenario.requests : [];
    for (let index = 0; index < requests.length; index += 1) {
      const decision = await context.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId: `tool-${index + 1}`,
            kind: "execute",
            status: "pending",
            title: "Controlled capability request",
            rawInput: requests[index],
          },
          options: permissionOptions(),
        },
      );
      if (
        decision.outcome.outcome === "selected" &&
        decision.outcome.optionId === "allow" &&
        sentinelPath !== null
      ) {
        await writeFile(`${sentinelPath}.${index + 1}`, "allowed\n", "utf8");
      }
      await context.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `tool-${index + 1}`,
          status:
            decision.outcome.outcome === "selected" &&
            decision.outcome.optionId === "allow"
              ? "completed"
              : "failed",
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

application.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
